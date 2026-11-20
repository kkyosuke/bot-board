import { afterEach, describe, expect, test } from "bun:test";

import { ClientAuthError, ClientTransportError } from "@/client/api/decision-client";
import { createHttpDecisionClient } from "@/client/api/http-decision-client";
import { DomainError } from "@/domain";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  const fn: typeof fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
  globalThis.fetch = fn;
}

const SAMPLE_CARD = {
  id: "card_1",
  proposalId: "prop_1",
  taskId: "task_1",
  taskTitle: "Sample Task",
  cardType: "policy",
  selectionMode: "binary",
  typeLabel: "方針確認",
  shortChip: "Sample",
  botName: "Grok Worker",
  submittedAtLabel: "12:00",
  version: 1,
  headline: "Approve policy?",
  summary: "Summary",
  acceptEffect: "Proceed",
  declineEffect: "Revise",
  factors: [{ label: "影響", value: "小" }],
  artifact: {
    id: "art_1",
    title: "Draft",
    kind: "markdown",
    version: 1,
    summary: "Short",
    excerpt: ["Line 1"],
  },
};

describe("http-decision-client (S6)", () => {
  test("parses listCards snapshot with provisionalCards & workspacePaused and preserves STALE_PROPOSAL replacementCardId", async () => {
    stubFetch((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(init?.credentials).toBe("include");
      if (url.endsWith("/api/human/cards")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              pendingCards: [SAMPLE_CARD],
              deferredCards: [],
              provisionalCards: [
                {
                  card: { ...SAMPLE_CARD, id: "card_prov", version: 2 },
                  decisionId: "dec_1",
                  decision: "accepted",
                  selectedOptionIds: [],
                  provisionalUntil: Date.now() + 4_000,
                },
              ],
              workspacePaused: true,
              hasActiveBots: true,
              runningTaskCount: 1,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/api/human/cards/card_1/decide")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "STALE_PROPOSAL",
              message: "Target changed",
              retryable: false,
              details: { replacementCardId: "card_reconfirm_9" },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const client = createHttpDecisionClient();
    const snap = await client.listCards();
    expect(snap.pendingCards).toHaveLength(1);
    expect(snap.provisionalCards).toHaveLength(1);
    expect(snap.workspacePaused).toBe(true);

    let staleErr: unknown = null;
    try {
      await client.decideCard({
        cardId: "card_1",
        expectedVersion: 1,
        requestId: "req-1",
        payload: { mode: "binary", decision: "accepted" },
      });
    } catch (err) {
      staleErr = err;
    }
    expect(staleErr).toBeInstanceOf(DomainError);
    if (staleErr instanceof DomainError) {
      expect(staleErr.code).toBe("STALE_PROPOSAL");
      expect(staleErr.details?.replacementCardId).toBe("card_reconfirm_9");
    }
  });

  test("maps 401/403 to ClientAuthError and network/non-JSON 200 failure to ClientTransportError", async () => {
    const client = createHttpDecisionClient();

    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ message: "Auth required" }), { status: 401 })),
    );
    await expect(client.listCards()).rejects.toBeInstanceOf(ClientAuthError);

    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })),
    );
    await expect(client.listCards()).rejects.toBeInstanceOf(ClientAuthError);

    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(client.listCards()).rejects.toBeInstanceOf(ClientTransportError);

    stubFetch(() => Promise.resolve(new Response("<html>bad gateway</html>", { status: 200 })));
    await expect(client.listCards()).rejects.toBeInstanceOf(ClientTransportError);
  });
});
