import { describe, expect, test } from "bun:test";

import {
  createGeminiModelAdapter,
  createMetaMuseModelAdapter,
  DEFAULT_GEMINI_CHAT_COMPLETIONS_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_META_MODEL_CHAT_COMPLETIONS_URL,
  DEFAULT_META_MUSE_MODEL,
  ModelAdapterError,
  type ModelStepContext,
  parseWorkerLlmProvider,
  WORKER_LLM_PROVIDERS,
} from "@/adapters";
import { DomainError } from "@/domain";

const SAMPLE_CONTEXT: ModelStepContext = {
  workspaceGoal: "個人開発アプリ bot-board の自律調査とマルチBot連携",
  allowedScope: "調査・タスク分解・設計下書き",
  task: {
    id: "task-multi-1",
    title: "競合調査と企画比較",
    description: "モバイル判断カード向けの比較表を作成する",
    status: "running",
    requiresApproval: true,
    version: 3,
    retryCount: 0,
  },
  latestArtifacts: [
    {
      id: "art-multi-1",
      title: "調査メモ",
      kind: "markdown",
      summary: "初期調査サマリー",
      version: 1,
    },
  ],
};

function createStubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("Multi-provider autonomous worker adapters (Google Gemini & Meta Muse)", () => {
  test("parseWorkerLlmProvider accepts canonical providers case-insensitively and rejects unknown values", () => {
    expect(WORKER_LLM_PROVIDERS).toEqual(["grok", "gemini", "meta-muse"]);
    expect(parseWorkerLlmProvider("grok")).toBe("grok");
    expect(parseWorkerLlmProvider("  GEMINI  ")).toBe("gemini");
    expect(parseWorkerLlmProvider("Meta-Muse")).toBe("meta-muse");
    expect(parseWorkerLlmProvider("openai")).toBeNull();
    expect(parseWorkerLlmProvider("")).toBeNull();
  });

  test("Google Gemini adapter uses official OpenAI-compatible endpoint/model, omits deprecated temperature, sets reasoning_effort=low, enforces usage floor, and never leaks GEMINI_API_KEY", async () => {
    const secretKey = "AIzaSy-test-gemini-secret-never-leak-9999";
    const captured: { url: string; auth: string | null; body: string } = {
      url: "",
      auth: null,
      body: "",
    };

    const adapter = createGeminiModelAdapter({
      apiKey: secretKey,
      endpointUrl: "   ", // Blank override falls back to official default URL
      model: "  ", // Blank override falls back to official default model
      fetchImpl: createStubFetch((input, init) => {
        captured.url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        captured.auth = new Headers(init?.headers).get("Authorization");
        captured.body = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      action: "submit_proposal",
                      proposals: [
                        {
                          card_type: "policy",
                          selection_mode: "binary",
                          title: "Gemini調査方針を採用する？",
                          summary: "3軸で比較調査を進めます。",
                          on_accept_effect: "詳細比較表を作成",
                          on_decline_effect: "別軸で再提案",
                          on_decline_policy: "revise",
                          factors: [{ label: "モデル", value: "gemini-3.5-flash-lite" }],
                        },
                      ],
                      estimated_cost_cents: 0,
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 2_000,
                completion_tokens: 1_000,
                completion_tokens_details: {
                  reasoning_tokens: 12_000,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    });

    expect(adapter.name).toBe(`google-gemini:${DEFAULT_GEMINI_MODEL}`);
    const out = await adapter.executeStep(SAMPLE_CONTEXT, {
      timeoutMs: 10_000,
      leaseRemainingMs: 60_000,
    });

    expect(captured.url).toBe(DEFAULT_GEMINI_CHAT_COMPLETIONS_URL);
    expect(captured.auth).toBe(`Bearer ${secretKey}`);
    expect(captured.body).not.toContain(secretKey);

    const reqObj = parseJsonObject(captured.body);
    expect(reqObj["model"]).toBe("gemini-3.5-flash-lite");
    expect(reqObj["max_completion_tokens"]).toBe(2048);
    expect(reqObj["reasoning_effort"]).toBe("low");
    expect("temperature" in reqObj).toBe(false);
    expect(reqObj["response_format"]).toEqual({ type: "json_object" });

    expect(out.action).toBe("submit_proposal");
    // 2000 + 1000 + 12000 = 15000 tokens -> ceil(15000 / 10000) = 2 cents
    expect(out.estimated_cost_cents).toBe(2);

    // Lease timeout guard triggers BEFORE network call
    let called = 0;
    const guardAdapter = createGeminiModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() => {
        called += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    });
    await expect(
      guardAdapter.executeStep(SAMPLE_CONTEXT, { timeoutMs: 60_000, leaseRemainingMs: 60_000 }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(called).toBe(0);

    // 429 quota exhaustion (e.g. API-key monthly cap) -> retryable RATE_LIMITED without leaking key
    const quotaAdapter = createGeminiModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: `RESOURCE_EXHAUSTED for ${secretKey}` } }),
            { status: 429, headers: { "Retry-After": "30" } },
          ),
        ),
      ),
    });
    let quotaErr: unknown = null;
    try {
      await quotaAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (err) {
      quotaErr = err;
    }
    expect(quotaErr).toBeInstanceOf(ModelAdapterError);
    if (quotaErr instanceof ModelAdapterError) {
      expect(quotaErr.kind).toBe("retryable");
      expect(quotaErr.reasonCode).toBe("RATE_LIMITED");
      expect(quotaErr.retryAfterSeconds).toBe(30);
      expect(quotaErr.message).not.toContain(secretKey);
    }

    // Missing API key -> permanent MISSING_API_KEY naming GEMINI_API_KEY
    const missingKeyAdapter = createGeminiModelAdapter({ apiKey: "   " });
    let missingGeminiErr: unknown = null;
    try {
      await missingKeyAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (err) {
      missingGeminiErr = err;
    }
    expect(missingGeminiErr).toBeInstanceOf(ModelAdapterError);
    if (missingGeminiErr instanceof ModelAdapterError) {
      expect(missingGeminiErr.kind).toBe("permanent");
      expect(missingGeminiErr.reasonCode).toBe("MISSING_API_KEY");
      expect(missingGeminiErr.message).toContain("GEMINI_API_KEY");
    }
  });

  test("Meta Muse (Meta Model API) adapter uses api.meta.ai + muse-spark-1.3, omits temperature, never sends reasoning_effort=none, tolerates null usage fields, and never leaks META_MODEL_API_KEY", async () => {
    const secretKey = "meta-model-secret-never-leak-7777";
    const captured: { url: string; auth: string | null; body: string } = {
      url: "",
      auth: null,
      body: "",
    };

    const adapter = createMetaMuseModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch((input, init) => {
        captured.url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        captured.auth = new Headers(init?.headers).get("Authorization");
        captured.body = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '```json\n{"action":"update_task","status":"ready","description":"Meta Muse step ok","estimated_cost_cents":0}\n```',
                  },
                },
              ],
              usage: {
                prompt_tokens: 900,
                completion_tokens: 300,
                total_tokens: null,
                completion_tokens_details: null,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    });

    expect(adapter.name).toBe(`meta-muse:${DEFAULT_META_MUSE_MODEL}`);
    const out = await adapter.executeStep(SAMPLE_CONTEXT, {
      timeoutMs: 10_000,
      leaseRemainingMs: 60_000,
    });

    expect(captured.url).toBe(DEFAULT_META_MODEL_CHAT_COMPLETIONS_URL);
    expect(captured.auth).toBe(`Bearer ${secretKey}`);
    expect(captured.body).not.toContain(secretKey);

    const reqObj = parseJsonObject(captured.body);
    expect(reqObj["model"]).toBe("muse-spark-1.3");
    expect(reqObj["max_completion_tokens"]).toBe(2048);
    expect(reqObj["reasoning_effort"]).toBe("low");
    expect(reqObj["reasoning_effort"]).not.toBe("none");
    expect("temperature" in reqObj).toBe(false);
    expect(reqObj["response_format"]).toEqual({ type: "json_object" });

    expect(out.action).toBe("update_task");
    expect(out.estimated_cost_cents).toBe(1);

    // 401 -> permanent AUTH_ERROR with zero secret leakage
    const authErrAdapter = createMetaMuseModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: `Invalid Meta key ${secretKey}` }), { status: 401 }),
        ),
      ),
    });
    let authErr: unknown = null;
    try {
      await authErrAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (err) {
      authErr = err;
    }
    expect(authErr).toBeInstanceOf(ModelAdapterError);
    if (authErr instanceof ModelAdapterError) {
      expect(authErr.kind).toBe("permanent");
      expect(authErr.reasonCode).toBe("AUTH_ERROR");
      expect(authErr.message).not.toContain(secretKey);
    }

    // Missing API key -> permanent MISSING_API_KEY naming META_MODEL_API_KEY
    const missingKeyAdapter = createMetaMuseModelAdapter({ apiKey: "" });
    let missingMetaErr: unknown = null;
    try {
      await missingKeyAdapter.executeStep(SAMPLE_CONTEXT, {
        timeoutMs: 5_000,
        leaseRemainingMs: 60_000,
      });
    } catch (err) {
      missingMetaErr = err;
    }
    expect(missingMetaErr).toBeInstanceOf(ModelAdapterError);
    if (missingMetaErr instanceof ModelAdapterError) {
      expect(missingMetaErr.kind).toBe("permanent");
      expect(missingMetaErr.reasonCode).toBe("MISSING_API_KEY");
      expect(missingMetaErr.message).toContain("META_MODEL_API_KEY");
    }
  });
});
