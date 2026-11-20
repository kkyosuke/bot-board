import { describe, expect, test } from "bun:test";

import {
  assertModelTimeoutWithinLease,
  createGrokModelAdapter,
  ModelAdapterError,
  type ModelStepContext,
} from "@/adapters";
import { DomainError } from "@/domain";

const SAMPLE_CONTEXT: ModelStepContext = {
  workspaceGoal: "個人開発アプリ bot-board の競合調査と MVP 完成",
  allowedScope: "調査・タスク分解・設計下書き",
  task: {
    id: "task-1",
    title: "競合3社の操作性比較",
    description: "モバイル片手スワイプの比較表を作成する",
    status: "running",
    requiresApproval: true,
    version: 2,
    retryCount: 0,
  },
  latestArtifacts: [
    {
      id: "art-1",
      title: "調査メモ",
      kind: "markdown",
      summary: "3社の基本機能一覧",
      version: 1,
    },
  ],
  triggerDecision: {
    id: "dec-1",
    result: "accepted",
    proposalTitle: "比較軸を3項目に絞る？",
    cardType: "policy",
    selectionMode: "binary",
    selectedOptionIds: [],
  },
};

function createStubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

describe("Model Adapter common contract & xAI Grok adapter (S7)", () => {
  test("rejects timeoutMs >= leaseRemainingMs BEFORE issuing any network request", async () => {
    let fetchCalled = 0;
    const adapter = createGrokModelAdapter({
      apiKey: "xai-secret-key-never-leak-1234",
      fetchImpl: createStubFetch(() => {
        fetchCalled += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    });

    await expect(
      adapter.executeStep(SAMPLE_CONTEXT, { timeoutMs: 30_000, leaseRemainingMs: 30_000 }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      adapter.executeStep(SAMPLE_CONTEXT, { timeoutMs: 45_000, leaseRemainingMs: 30_000 }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(() => assertModelTimeoutWithinLease({ timeoutMs: 0, leaseRemainingMs: 30_000 })).toThrow(
      DomainError,
    );
    expect(fetchCalled).toBe(0);
  });

  test("executes valid xAI chat completion step, passes minimal sanitized payload, and enforces usage cost floor", async () => {
    const captured: {
      authHeader: string | null;
      bodyText: string;
      signalAborted: boolean | undefined;
    } = {
      authHeader: null,
      bodyText: "",
      signalAborted: undefined,
    };

    const adapter = createGrokModelAdapter({
      apiKey: "xai-test-secret-token",
      model: "grok-3-mini",
      endpointUrl: "https://xai.example.test/v1/chat/completions",
      fetchImpl: createStubFetch((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        expect(url).toBe("https://xai.example.test/v1/chat/completions");
        captured.authHeader = new Headers(init?.headers).get("Authorization");
        captured.bodyText = typeof init?.body === "string" ? init.body : "";
        captured.signalAborted = init?.signal?.aborted;

        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      action: "submit_proposal",
                      artifact: {
                        title: "競合比較レポート",
                        kind: "markdown",
                        summary: "3社の片手操作比較",
                        content_or_url: "# Report\nDone",
                      },
                      proposals: [
                        {
                          card_type: "deliverable",
                          selection_mode: "binary",
                          title: "競合比較レポートを受け入れる？",
                          summary: "3軸比較が完了しました。",
                          on_accept_effect: "タスク完了",
                          on_decline_effect: "修正版を作成",
                          on_decline_policy: "revise",
                          factors: [{ label: "対象", value: "3社" }],
                        },
                      ],
                      estimated_cost_cents: 0,
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    });

    const output = await adapter.executeStep(SAMPLE_CONTEXT, {
      timeoutMs: 10_000,
      leaseRemainingMs: 60_000,
    });

    expect(captured.authHeader).toBe("Bearer xai-test-secret-token");
    expect(captured.signalAborted).toBe(false);
    expect(captured.bodyText).toContain("競合3社の操作性比較");
    expect(captured.bodyText).not.toContain("xai-test-secret-token");
    expect(output.action).toBe("submit_proposal");
    // Usage floor enforces at least 1 cent when total_tokens > 0
    expect(output.estimated_cost_cents).toBe(1);
  });

  test("classifies 429/5xx/timeout/network as retryable and 401/400/bad-schema/missing-key as permanent with zero API key leakage", async () => {
    const secretKey = "xai-super-secret-value-99999";

    // 429 with Retry-After -> retryable RATE_LIMITED
    const rateLimitedAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: `Rate limited for ${secretKey}` }), {
            status: 429,
            headers: { "Retry-After": "22" },
          }),
        ),
      ),
    });
    let err429: unknown = null;
    try {
      await rateLimitedAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (e) {
      err429 = e;
    }
    expect(err429).toBeInstanceOf(ModelAdapterError);
    if (err429 instanceof ModelAdapterError) {
      expect(err429.kind).toBe("retryable");
      expect(err429.reasonCode).toBe("RATE_LIMITED");
      expect(err429.retryAfterSeconds).toBe(22);
      expect(err429.message).not.toContain(secretKey);
    }

    // 503 -> retryable UPSTREAM_5XX
    const upstream5xxAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(new Response("Service Unavailable", { status: 503 })),
      ),
    });
    await expect(
      upstream5xxAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: "retryable", reasonCode: "UPSTREAM_5XX" });

    // TimeoutError -> retryable TIMEOUT
    const timeoutAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      ),
    });
    await expect(
      timeoutAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: "retryable", reasonCode: "TIMEOUT" });

    // Network TypeError -> retryable NETWORK_ERROR
    const networkAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() => Promise.reject(new TypeError("Failed to fetch"))),
    });
    await expect(
      networkAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: "retryable", reasonCode: "NETWORK_ERROR" });

    // 401 -> permanent AUTH_ERROR with zero secret leakage
    const authErrAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: `Invalid key ${secretKey}` }), { status: 401 }),
        ),
      ),
    });
    let err401: unknown = null;
    try {
      await authErrAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (e) {
      err401 = e;
    }
    expect(err401).toBeInstanceOf(ModelAdapterError);
    if (err401 instanceof ModelAdapterError) {
      expect(err401.kind).toBe("permanent");
      expect(err401.reasonCode).toBe("AUTH_ERROR");
      expect(err401.message).not.toContain(secretKey);
    }

    // Invalid step output schema -> permanent SCHEMA_INVALID
    const badSchemaAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ action: "approve_card" }) } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });
    await expect(
      badSchemaAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: "permanent", reasonCode: "SCHEMA_INVALID" });

    // Blank API key -> permanent MISSING_API_KEY
    const missingKeyAdapter = createGrokModelAdapter({ apiKey: "   " });
    await expect(
      missingKeyAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: "permanent", reasonCode: "MISSING_API_KEY" });
  });

  test("classifies response.json() timeout as retryable TIMEOUT, applies 1-cent floor for empty usage {}, and rejects cross-field schema violations", async () => {
    const secretKey = "xai-test-cross-field-key";

    // Body-read TimeoutError during response.json() -> retryable TIMEOUT (not permanent SCHEMA_INVALID)
    const bodyTimeoutAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() => {
        const fakeResponse = new Response("", { status: 200 });
        Object.defineProperty(fakeResponse, "json", {
          value: () => Promise.reject(new DOMException("Body read timed out", "TimeoutError")),
        });
        return Promise.resolve(fakeResponse);
      }),
    });
    await expect(
      bodyTimeoutAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: "retryable", reasonCode: "TIMEOUT" });

    // Empty usage {} applies conservative 1-cent floor
    const emptyUsageAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      action: "update_task",
                      status: "ready",
                      estimated_cost_cents: 0,
                    }),
                  },
                },
              ],
              usage: {},
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });
    const emptyUsageResult = await emptyUsageAdapter.executeStep(SAMPLE_CONTEXT, {
      timeoutMs: 5_000,
      leaseRemainingMs: 60_000,
    });
    expect(emptyUsageResult.estimated_cost_cents).toBe(1);

    // Cross-field schema violations -> permanent SCHEMA_INVALID before touching Bot services
    const invalidOutputs: readonly unknown[] = [
      // binary with non-empty options
      {
        action: "submit_proposal",
        proposals: [
          {
            card_type: "policy",
            selection_mode: "binary",
            options: [{ id: "a", title: "A", summary: "S", meta: "M" }],
            title: "Bad binary",
            summary: "S",
            on_accept_effect: "A",
            on_decline_effect: "D",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      // single with duplicate option IDs
      {
        action: "submit_proposal",
        proposals: [
          {
            card_type: "choice",
            selection_mode: "single",
            options: [
              { id: "dup", title: "A", summary: "S", meta: "M" },
              { id: "dup", title: "B", summary: "S", meta: "M" },
            ],
            title: "Dup options",
            summary: "S",
            on_accept_effect: "A",
            on_decline_effect: "D",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      // mixed on_decline_policy across group proposals
      {
        action: "submit_proposal",
        proposals: [
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "P1",
            summary: "S",
            on_accept_effect: "A",
            on_decline_effect: "D",
            on_decline_policy: "revise",
            factors: [],
          },
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "P2",
            summary: "S",
            on_accept_effect: "A",
            on_decline_effect: "D",
            on_decline_policy: "block",
            factors: [],
          },
        ],
      },
      // artifact.id without expected_version
      {
        action: "update_task",
        status: "ready",
        artifact: {
          id: "art-1",
          title: "Missing version",
          kind: "markdown",
          summary: "S",
          content_or_url: "Body",
        },
      },
    ];

    for (const badPayload of invalidOutputs) {
      const adapter = createGrokModelAdapter({
        apiKey: secretKey,
        fetchImpl: createStubFetch(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: JSON.stringify(badPayload) } }],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          ),
        ),
      });
      await expect(
        adapter.executeStep(SAMPLE_CONTEXT, { timeoutMs: 5_000, leaseRemainingMs: 60_000 }),
      ).rejects.toMatchObject({ kind: "permanent", reasonCode: "SCHEMA_INVALID" });
    }
  });

  test("strips markdown json fences, accounts for reasoning_tokens, sets max_completion_tokens/reasoning_effort, handles null content, documents full strict schema in prompt, and sanitizes Zod issue paths (B4)", async () => {
    const secretKey = "xai-b4-secret-never-leak";
    let sentBody = "";

    const fencedAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch((_input, init) => {
        sentBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '```json\n{"action":"update_task","status":"ready","estimated_cost_cents":0}\n```',
                  },
                },
              ],
              usage: {
                prompt_tokens: 1_000,
                completion_tokens: 500,
                completion_tokens_details: {
                  reasoning_tokens: 24_000,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    });

    const out = await fencedAdapter.executeStep(SAMPLE_CONTEXT, {
      timeoutMs: 5_000,
      leaseRemainingMs: 60_000,
    });
    expect(out.action).toBe("update_task");
    // 1000 + 500 + 24000 = 25500 tokens -> ceil(25500 / 10000) = 3 cents
    expect(out.estimated_cost_cents).toBe(3);

    const reqObj: unknown = JSON.parse(sentBody);
    expect(reqObj).toMatchObject({
      model: "grok-3-mini",
      max_completion_tokens: 2048,
      reasoning_effort: "low",
    });

    // Prompt must document all required strict keys, exact domain enums, and contain zero {...} / [...] / invalid "stop"
    expect(sentBody).not.toContain("{...}");
    expect(sentBody).not.toContain("[...]");
    expect(sentBody).not.toContain('"stop"');
    expect(sentBody).toContain('\\"on_decline_policy\\":\\"revise\\"|\\"block\\"');
    expect(sentBody).toContain('\\"card_type\\":\\"policy\\"|\\"choice\\"|\\"deliverable\\"');
    expect(sentBody).toContain('\\"selection_mode\\":\\"binary\\"|\\"single\\"|\\"multi\\"');
    for (const requiredKey of [
      "card_type",
      "selection_mode",
      "on_accept_effect",
      "on_decline_effect",
      "on_decline_policy",
      "content_or_url",
      "estimated_cost_cents",
      "options",
      "factors",
      "subtasks",
      "expected_version",
    ]) {
      expect(sentBody).toContain(requiredKey);
    }

    // Null content returns clean SCHEMA_INVALID error
    const nullContentAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: null } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });
    await expect(
      nullContentAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      }),
    ).rejects.toMatchObject({
      kind: "permanent",
      reasonCode: "SCHEMA_INVALID",
    });

    // Schema violation includes sanitized Zod field path without leaking raw model values or secretKey
    const badFieldAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      action: "update_task",
                      status: "ready",
                      unknown_field: `secret-${secretKey}`,
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });
    let schemaErr: unknown = null;
    try {
      await badFieldAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (e) {
      schemaErr = e;
    }
    expect(schemaErr).toBeInstanceOf(ModelAdapterError);
    if (schemaErr instanceof ModelAdapterError) {
      expect(schemaErr.reasonCode).toBe("SCHEMA_INVALID");
      expect(schemaErr.message).toContain("unrecognized_keys");
      expect(schemaErr.message).not.toContain(secretKey);
    }
  });
});
