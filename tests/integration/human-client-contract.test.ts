import { afterEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createBetterAuth, ensureOwnerWorkspace, parseTrustedOrigins } from "@/auth/better-auth";
import { verifyBotConnectionContext } from "@/auth/bot";
import { authenticateOwnerRequest } from "@/auth/owner";
import { hashOAuthOpaqueToken } from "@/auth/token-hash";
import { createHttpDecisionClient } from "@/client/api/http-decision-client";
import {
  createHumanWorkerBotApi,
  fetchHumanBoard,
  fetchHumanBots,
  fetchHumanHistory,
  fetchHumanWorkspace,
  retryHumanTaskApi,
  updateHumanBotApi,
  updateHumanWorkspaceApi,
} from "@/client/api/human-api-client";
import { schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import { DomainError } from "@/domain";
import { createApp } from "@/server/app";
import { mountHumanRoutes } from "@/server/routes/human";
import { claimTask, createTask, recordResult, submitProposal } from "@/services/bot";
import { createHumanServicePort } from "@/services/human";
import {
  type BotWorkQueuePayload,
  type DecisionFinalizeQueuePayload,
  finalizeDecisionCard,
  type QueueSendOptions,
} from "@/services/system";

const ORIGIN = "https://board.example.test";
const OWNER_GITHUB_ID = "github-owner-contract-1";
const AUTH_SECRET = "contract-test-secret-key-0123456789abcdef";

const originalFetch = globalThis.fetch;
const openDbs: SqliteAppDatabase[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

async function signSessionCookie(sessionToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionToken));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${sigB64}`)}`;
}

async function createContractHarness() {
  const db = createSqliteDatabase(":memory:");
  openDbs.push(db);
  await db.applyMigrations();

  let nowMs = 1_760_200_000_000;
  const ownerUserId = "user-contract-owner";
  const sessionToken = "sess-contract-owner-token";

  await db.orm.insert(schema.user).values({
    id: ownerUserId,
    name: "Contract Owner",
    email: "contract@example.test",
    emailVerified: true,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });
  await db.orm.insert(schema.account).values({
    id: "acc-contract-gh",
    accountId: OWNER_GITHUB_ID,
    providerId: "github",
    userId: ownerUserId,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });
  await db.orm.insert(schema.session).values({
    id: "sess-contract-1",
    token: sessionToken,
    userId: ownerUserId,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  const workspaceId = await ensureOwnerWorkspace(db, ownerUserId, nowMs);
  const ownerCookie = await signSessionCookie(sessionToken);

  const botId = "bot-contract-1";
  const botToken = "bbw_contract_worker_secret";
  await db.orm.insert(schema.botConnections).values({
    id: botId,
    workspaceId,
    displayName: "Grok Contract Worker",
    channelType: "worker_bearer",
    oauthClientId: null,
    tokenHash: await hashOAuthOpaqueToken(botToken),
    scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
    status: "active",
    version: 1,
    createdAt: nowMs,
    updatedAt: nowMs,
  });

  const botCtx = verifyBotConnectionContext({
    botConnectionId: botId,
    workspaceId,
    workspaceOwnerUserId: ownerUserId,
    isWorkspacePaused: false,
    channelType: "worker_bearer",
    status: "active",
    connectionScopes: ["tasks:read", "tasks:write", "proposals:write", "decisions:read"],
  });

  const finalizeSent: DecisionFinalizeQueuePayload[] = [];
  const botWorkSent: BotWorkQueuePayload[] = [];
  const finalizeQueue = {
    send(msg: DecisionFinalizeQueuePayload, _opts?: QueueSendOptions) {
      finalizeSent.push(msg);
      return Promise.resolve();
    },
  };
  const botWorkQueue = {
    send(msg: BotWorkQueuePayload, _opts?: QueueSendOptions) {
      botWorkSent.push(msg);
      return Promise.resolve();
    },
  };

  const trustedOrigins = parseTrustedOrigins(ORIGIN);
  const auth = createBetterAuth(db, {
    baseUrl: ORIGIN,
    secret: AUTH_SECRET,
    trustedOrigins,
    ownerGithubId: OWNER_GITHUB_ID,
    enableMcpOAuth: false,
    now: () => nowMs,
  });

  const app = createApp({
    mountHumanRoutes(honoApp) {
      mountHumanRoutes(honoApp, {
        authenticateOwner: (request) =>
          authenticateOwnerRequest({
            db,
            auth,
            request,
            ownerGithubId: OWNER_GITHUB_ID,
          }),
        port: createHumanServicePort(db, {
          finalizeQueue,
          botWorkQueue,
          now: () => nowMs,
        }),
        trustedOrigins,
      });
    },
  });

  const requestPaths: string[] = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const resolvedUrl = rawUrl.startsWith("/") ? `${ORIGIN}${rawUrl}` : rawUrl;
      requestPaths.push(`${init?.method ?? "GET"} ${new URL(resolvedUrl).pathname}`);
      const headers = new Headers(init?.headers);
      headers.set("Cookie", ownerCookie);
      headers.set("Origin", ORIGIN);
      return await app.fetch(
        new Request(resolvedUrl, {
          ...init,
          headers,
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  globalThis.fetch = fetchImpl;

  return {
    db,
    workspaceId,
    botId,
    botCtx,
    botWorkQueue,
    requestPaths,
    getNow: () => nowMs,
    advanceNow: (deltaMs: number) => {
      nowMs += deltaMs;
    },
  };
}

describe("Client <-> Real Backend Human API Contract (S6 Mechanical Ratchet)", () => {
  test("exercises createHttpDecisionClient against real mountHumanRoutes (list, detail, decide, undo single-GET, defer/restore, STALE_PROPOSAL)", async () => {
    const h = await createContractHarness();

    const created = await createTask(
      h.db,
      h.botCtx,
      {
        request_id: "bot-create-1",
        title: "競合調査レポート",
        description: "主要3社の比較",
        requires_approval: true,
      },
      h.getNow(),
    );
    const claimed = await claimTask(
      h.db,
      h.botCtx,
      {
        request_id: "bot-claim-1",
        task_id: created.task_id,
        expected_version: created.version,
        lease_duration_seconds: 120,
      },
      h.getNow(),
    );
    const submitted = await submitProposal(
      h.db,
      h.botCtx,
      {
        request_id: "bot-prop-1",
        task_id: created.task_id,
        expected_version: claimed.version,
        lease_token: claimed.lease_token,
        selection_group_id: "grp-contract-1",
        artifact: {
          title: "競合比較メモ",
          kind: "markdown",
          summary: "3社の差分まとめ",
          content_or_url: "# Full Artifact Content\nVerified via real backend contract!",
        },
        proposals: [
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "比較軸を3項目に絞る？",
            summary: "価格・SP操作性・API連携の3軸で比較します。",
            on_accept_effect: "3軸比較でレポート作成へ進む",
            on_decline_effect: "別案を再検討する",
            on_decline_policy: "revise",
            factors: [{ label: "工数", value: "30分" }],
          },
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "比較軸を5項目へ広げる？",
            summary: "詳細比較を追加します。",
            on_accept_effect: "5軸比較へ進む",
            on_decline_effect: "別案を再検討する",
            on_decline_policy: "revise",
            factors: [{ label: "工数", value: "90分" }],
          },
        ],
      },
      h.getNow(),
    );
    const card1 = submitted.cards[0];
    const card2 = submitted.cards[1];
    expect(card1).toBeDefined();
    expect(card2).toBeDefined();
    if (card1 === undefined || card2 === undefined) {
      return;
    }

    const client = createHttpDecisionClient();

    // 1. listCards
    const initial = await client.listCards();
    expect(initial.pendingCards).toHaveLength(2);
    expect(initial.provisionalCards).toHaveLength(0);
    expect(initial.hasActiveBots).toBe(true);
    expect(initial.workspacePaused).toBe(false);

    // 2. getCardDetail (real full artifact + sibling comparison)
    const detail = await client.getCardDetail?.(card1.card_id);
    expect(detail?.artifactFull?.contentOrUrl).toContain("Full Artifact Content");
    expect(detail?.siblings).toHaveLength(1);
    expect(detail?.siblings[0]?.cardId).toBe(card2.card_id);

    // 3. decideCard (locks sibling in group)
    const receipt = await client.decideCard({
      cardId: card1.card_id,
      expectedVersion: card1.version,
      requestId: "human-decide-1",
      payload: { mode: "binary", decision: "accepted" },
    });
    expect(receipt.status).toBe("provisional");
    expect(receipt.closedSiblingCardIds).toContain(card2.card_id);

    // 4. listCards during provisional window returns provisionalCards for reload recovery
    const mid = await client.listCards();
    expect(mid.pendingCards).toHaveLength(0);
    expect(mid.provisionalCards).toHaveLength(1);
    expect(mid.provisionalCards?.[0]?.card.id).toBe(card1.card_id);

    // 5. undoCard returns refreshedSnapshot in a SINGLE GET /api/human/cards call
    h.requestPaths.length = 0;
    const undoReceipt = await client.undoCard({
      cardId: card1.card_id,
      expectedVersion: receipt.newVersion,
      requestId: "human-undo-1",
    });
    expect(undoReceipt.status).toBe("pending");
    expect(undoReceipt.restoredCard.id).toBe(card1.card_id);
    expect(undoReceipt.refreshedSnapshot?.pendingCards).toHaveLength(2);
    expect(h.requestPaths.filter((p) => p === "GET /api/human/cards")).toHaveLength(1);

    // 6. deferCard (defer + restore)
    const deferred = await client.deferCard({
      cardId: card1.card_id,
      expectedVersion: undoReceipt.newVersion,
      requestId: "human-defer-1",
      action: "defer",
    });
    expect(deferred.status).toBe("deferred");

    const restored = await client.deferCard({
      cardId: card1.card_id,
      expectedVersion: deferred.newVersion,
      requestId: "human-restore-1",
      action: "restore",
    });
    expect(restored.status).toBe("pending");

    // 7. STALE_PROPOSAL when task version advances underneath card1 -> typed replacementCardId
    await h.db.orm
      .update(schema.tasks)
      .set({ version: submitted.task_version + 1, updatedAt: h.getNow() + 1 })
      .where(eq(schema.tasks.id, created.task_id));

    let staleErr: unknown = null;
    try {
      await client.decideCard({
        cardId: card1.card_id,
        expectedVersion: restored.newVersion,
        requestId: "human-stale-1",
        payload: { mode: "binary", decision: "accepted" },
      });
    } catch (err) {
      staleErr = err;
    }
    expect(staleErr).toBeInstanceOf(DomainError);
    if (staleErr instanceof DomainError) {
      expect(staleErr.code).toBe("STALE_PROPOSAL");
      expect(staleErr.details?.replacementCardId).toBeDefined();
    }
  });

  test("exercises all 8 human-api-client functions against real mountHumanRoutes (workspace, bots, board, retry, history)", async () => {
    const h = await createContractHarness();

    // 1. Workspace GET + PATCH
    const ws1 = await fetchHumanWorkspace();
    expect(ws1.version).toBe(1);
    const ws2 = await updateHumanWorkspaceApi({
      requestId: "ws-patch-1",
      expectedVersion: ws1.version,
      goal: "MVP Contract Goal",
      allowedScope: "調査・下書き",
      budgetLimit: {
        max_cards_per_day: 50,
        max_steps_per_task: 15,
        daily_cost_limit_cents: 1250,
      },
      isPaused: false,
    });
    expect(ws2.goal).toBe("MVP Contract Goal");
    expect(ws2.budget_limit.daily_cost_limit_cents).toBe(1250);
    expect(ws2.version).toBe(2);

    // 2. Bots GET + POST (1-time bearer) + PATCH (scopes -> paused -> revoked)
    const initialBots = await fetchHumanBots();
    expect(initialBots).toHaveLength(1);

    const issued = await createHumanWorkerBotApi({
      requestId: "bot-issue-1",
      displayName: "Secondary Worker",
      scopes: ["tasks:read", "tasks:write"],
    });
    expect(issued.bearer_token).toBeTruthy();

    const scoped = await updateHumanBotApi(issued.bot_id, {
      requestId: "bot-scope-1",
      expectedVersion: issued.version,
      scopes: ["tasks:read"],
    });
    expect(scoped.scopes).toEqual(["tasks:read"]);

    const paused = await updateHumanBotApi(issued.bot_id, {
      requestId: "bot-pause-1",
      expectedVersion: scoped.version,
      status: "paused",
    });
    expect(paused.status).toBe("paused");

    const revoked = await updateHumanBotApi(issued.bot_id, {
      requestId: "bot-revoke-1",
      expectedVersion: paused.version,
      status: "revoked",
    });
    expect(revoked.status).toBe("revoked");

    // 3. Create a failed task + a finalized decision for /board, /retry, /history
    const failedTask = await createTask(
      h.db,
      h.botCtx,
      {
        request_id: "t-fail-1",
        title: "DLQ 失敗タスク",
        description: "失敗テスト",
        requires_approval: true,
      },
      h.getNow(),
    );
    const claimedFail = await claimTask(
      h.db,
      h.botCtx,
      {
        request_id: "t-fail-claim",
        task_id: failedTask.task_id,
        expected_version: failedTask.version,
        lease_duration_seconds: 120,
      },
      h.getNow(),
    );
    const failRecorded = await recordResult(
      h.db,
      h.botCtx,
      {
        request_id: "t-fail-rec",
        task_id: failedTask.task_id,
        expected_version: claimedFail.version,
        lease_token: claimedFail.lease_token,
        outcome: "failed",
        status_reason: "Model API timeout",
      },
      h.getNow(),
    );
    expect(failRecorded.status).toBe("failed");

    // Board GET + Retry failed task
    const boardBefore = await fetchHumanBoard();
    expect(boardBefore.columns.failed).toHaveLength(1);
    const failedDto = boardBefore.columns.failed[0];
    expect(failedDto?.retry_count).toBe(1);
    expect(failedDto?.status_reason).toBe("Model API timeout");

    const retried = await retryHumanTaskApi(failedTask.task_id, {
      requestId: "retry-1",
      expectedVersion: failRecorded.version,
    });
    expect(retried.status).toBe("ready");

    // Finalized decision -> History GET (all, accepted, declined, failed)
    const histTask = await createTask(
      h.db,
      h.botCtx,
      {
        request_id: "t-hist-1",
        title: "履歴確認タスク",
        description: "成果承認",
        requires_approval: true,
      },
      h.getNow(),
    );
    const histClaim = await claimTask(
      h.db,
      h.botCtx,
      {
        request_id: "t-hist-claim",
        task_id: histTask.task_id,
        expected_version: histTask.version,
        lease_duration_seconds: 120,
      },
      h.getNow(),
    );
    const histProp = await submitProposal(
      h.db,
      h.botCtx,
      {
        request_id: "t-hist-prop",
        task_id: histTask.task_id,
        expected_version: histClaim.version,
        lease_token: histClaim.lease_token,
        proposals: [
          {
            card_type: "deliverable",
            selection_mode: "binary",
            title: "成果を受け入れる？",
            summary: "ドラフト完成",
            on_accept_effect: "タスク完了",
            on_decline_effect: "やり直し",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      h.getNow(),
    );
    const histCard = histProp.cards[0];
    expect(histCard).toBeDefined();
    if (histCard === undefined) {
      return;
    }

    const decisionClient = createHttpDecisionClient();
    await decisionClient.decideCard({
      cardId: histCard.card_id,
      expectedVersion: histCard.version,
      requestId: "hist-decide-1",
      payload: { mode: "binary", decision: "accepted" },
    });

    h.advanceNow(6_000);
    await finalizeDecisionCard(h.db, histCard.card_id, {
      source: "queue",
      nowMs: h.getNow(),
      botWorkQueue: h.botWorkQueue,
    });

    const histAll = await fetchHumanHistory({ filter: "all", limit: 10 });
    expect(histAll.items).toHaveLength(1);
    expect(histAll.items[0]?.decision_result).toBe("accepted");
    expect(histAll.items[0]?.execution_status).toBe("done");

    const histDeclined = await fetchHumanHistory({ filter: "declined", limit: 10 });
    expect(histDeclined.items).toHaveLength(0);
  });
});
