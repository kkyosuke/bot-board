import { expect, type Page, test } from "@playwright/test";

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

async function assertAllVisibleButtonsAtLeast44px(page: Page): Promise<void> {
  const buttons = page.locator("button:visible");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const btn = buttons.nth(i);
    const isInteractive = await btn.evaluate(
      (el) => el.closest('[aria-hidden="true"], [inert]') === null,
    );
    if (!isInteractive) {
      continue;
    }
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
}

const LIVE_CARD_1 = {
  id: "card_live_1",
  proposalId: "prop_live_1",
  taskId: "task_live_1",
  taskTitle: "競合調査タスク",
  cardType: "policy",
  selectionMode: "binary",
  typeLabel: "方針確認",
  shortChip: "競合調査",
  botName: "Grok Worker",
  submittedAtLabel: "14:00",
  version: 1,
  headline: "競合3社の比較軸を確定する？",
  summary: "スワイプ体験・権限境界・費用上限の3軸で比較表を作成します。",
  acceptEffect: "3軸で比較調査を開始",
  declineEffect: "別の比較軸を再提案",
  factors: [{ label: "影響", value: "調査方針" }],
  artifact: {
    id: "art_live_1",
    title: "競合比較ドラフト",
    kind: "markdown",
    version: 1,
    summary: "3軸比較の初期ドラフト",
    excerpt: ["# 比較軸", "- スワイプ誤操作対策"],
  },
};

const LIVE_RECONFIRM_CARD = {
  ...LIVE_CARD_1,
  id: "card_reconfirm_2",
  proposalId: "prop_reconfirm_2",
  version: 1,
  shortChip: "[再確認]",
  headline: "[再確認] 競合3社の比較軸を確定する？",
  summary: "対象成果が v2 に更新されたため再確認が必要です。",
};

test.describe("S6 Secondary Screens (/board, /history, /settings) & Live /api/human/* Integration (UX-01, UX-02, BOT-03)", () => {
  test("connects / to live /api/human/cards with 401 redirect, 500 load-error retry, provisional reload undo, WORKSPACE_PAUSED banner, card detail, and STALE_PROPOSAL reconfirmation switch", async ({
    page,
  }) => {
    // 1. 401 on live / redirects to /sign-in
    await page.route("**/api/human/cards", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "NOT_AUTHORIZED", message: "Sign-in required" }),
      });
    });
    await page.route("**/api/human/workspace", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "NOT_AUTHORIZED", message: "Sign-in required" }),
      });
    });
    await page.route("**/api/auth/owner-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ initialized: true }),
      });
    });

    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByTestId("passkey-sign-in-btn")).toBeVisible();

    // 2. Initial 500 on live / shows explicit load-error card (NEVER false "All cleared") and recovers on retry
    let shouldFailCards = true;
    let cardsPhase: "initial" | "undone" | "reconfirm" = "initial";
    let undoCalls = 0;

    await page.unroute("**/api/human/cards");
    await page.route("**/api/human/cards", async (route) => {
      if (shouldFailCards) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "Temporary D1 outage" }),
        });
        return;
      }

      const pendingCards =
        cardsPhase === "initial"
          ? [LIVE_CARD_1]
          : cardsPhase === "undone"
            ? [
                {
                  ...LIVE_CARD_1,
                  id: "card_prov_reload",
                  headline: "リロード復帰された仮確定カード",
                  version: 3,
                },
                LIVE_CARD_1,
              ]
            : [LIVE_RECONFIRM_CARD];
      const provisionalCards =
        cardsPhase === "initial"
          ? [
              {
                card: {
                  ...LIVE_CARD_1,
                  id: "card_prov_reload",
                  headline: "リロード復帰された仮確定カード",
                  version: 2,
                },
                decisionId: "dec_prov_1",
                decision: "accepted",
                selectedOptionIds: [],
                provisionalUntil: Date.now() + 4_500,
              },
            ]
          : [];

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          pendingCards,
          deferredCards: [],
          provisionalCards,
          workspacePaused: true,
          hasActiveBots: true,
          runningTaskCount: 1,
        }),
      });
    });

    await page.route("**/api/human/cards/card_prov_reload/undo", async (route) => {
      undoCalls += 1;
      cardsPhase = "undone";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          card_id: "card_prov_reload",
          version: 3,
          status: "pending",
          restored_sibling_card_ids: [],
          trace_id: "evt_undo_reload",
        }),
      });
    });

    await page.route("**/api/human/cards/card_prov_reload", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          card: {
            ...LIVE_CARD_1,
            id: "card_prov_reload",
            headline: "リロード復帰された仮確定カード",
            version: 3,
          },
          status: "pending",
          provisionalResult: null,
          provisionalUntil: null,
          expiresAt: null,
          targetTaskVersion: 2,
          currentTaskVersion: 2,
          artifactFull: null,
          siblings: [],
          replacementCardId: null,
        }),
      });
    });

    await page.route("**/api/human/cards/card_live_1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          card: LIVE_CARD_1,
          status: "pending",
          provisionalResult: null,
          provisionalUntil: null,
          expiresAt: null,
          targetTaskVersion: 2,
          currentTaskVersion: 2,
          artifactFull: {
            id: "art_live_1",
            title: "競合比較ドラフト",
            kind: "markdown",
            summary: "3軸比較の初期ドラフト",
            contentOrUrl: "# Full Artifact Body\nLive GET /api/human/cards/:id loaded!",
            version: 1,
          },
          siblings: [
            {
              cardId: "card_sib_1",
              proposalId: "prop_sib_1",
              title: "別案: 5軸比較",
              status: "pending",
              version: 1,
            },
          ],
          replacementCardId: null,
        }),
      });
    });

    await page.route("**/api/human/cards/card_reconfirm_2", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          card: LIVE_RECONFIRM_CARD,
          status: "pending",
          provisionalResult: null,
          provisionalUntil: null,
          expiresAt: null,
          targetTaskVersion: 3,
          currentTaskVersion: 3,
          artifactFull: null,
          siblings: [],
          replacementCardId: null,
        }),
      });
    });

    await page.route("**/api/human/cards/card_live_1/decide", async (route) => {
      cardsPhase = "reconfirm";
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "STALE_PROPOSAL",
          message: "Target task or artifact changed.",
          retryable: false,
          details: { replacementCardId: "card_reconfirm_2" },
        }),
      });
    });

    await page.goto("/");
    await expect(page.getByTestId("live-load-error")).toBeVisible();
    await expect(page.getByTestId("state-card-empty")).toHaveCount(0);
    shouldFailCards = false;
    await page.getByTestId("btn-live-load-retry").click();

    await expect(page.getByTestId("decide-paused-banner")).toBeVisible();
    await expect(page.getByTestId("undo-banner")).toBeVisible();
    await expect(page.getByTestId("card-headline")).toContainText("競合3社の比較軸を確定する？");

    // Verify full artifact & siblings from GET /api/human/cards/card_live_1 render (PC inspector or SP sheet)
    const openDetailBtn = page.getByTestId("btn-open-detail");
    if (await openDetailBtn.isVisible()) {
      await openDetailBtn.click();
    }
    await expect(page.getByTestId("detail-artifact-full").first()).toContainText(
      "Live GET /api/human/cards/:id loaded!",
    );
    await expect(page.getByTestId("detail-siblings").first()).toContainText("別案: 5軸比較");
    const closeSheetBtn = page.getByTestId("btn-close-sheet");
    if (await closeSheetBtn.isVisible()) {
      await closeSheetBtn.click();
    }

    // Exercise btn-undo on reload-restored provisional card!
    await page.getByTestId("btn-undo").click();
    await expect(page.getByTestId("card-headline")).toContainText("リロード復帰された仮確定カード");
    expect(undoCalls).toBe(1);

    // Jump back to card_live_1 and trigger decide -> STALE_PROPOSAL -> UI switches to [再確認] replacement card!
    await page.getByTestId("queue-chip-card_live_1").click();
    await expect(page.getByTestId("card-headline")).toContainText("競合3社の比較軸を確定する？");
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("card-headline")).toContainText(
      "[再確認] 競合3社の比較軸を確定する？",
    );
    await assertNoHorizontalOverflow(page);
  });

  test("renders /board read-only Kanban (UX-01: zero drag/edit), Bot progress strip, BOT-03 failure reason & retry_count, independent lease badge, and failed-only retry", async ({
    page,
  }) => {
    let task3Status: "failed" | "ready" = "failed";
    let task3Version = 4;

    await page.route("**/api/human/board", async (route) => {
      const taskFailed = {
        id: "task-3",
        parent_task_id: null,
        title: "競合5アプリの誤スワイプ調査",
        description: "",
        status: task3Status,
        status_reason:
          task3Status === "failed" ? "モデルAPIタイムアウト上限超過（DLQ退避）" : "再試行待ち",
        requires_approval: true,
        assigned_bot_id: "bot-grok",
        assigned_bot_name: "Grok Worker",
        retry_count: task3Status === "failed" ? 3 : 0,
        version: task3Version,
        updated_at: Date.now(),
        active_lease: null,
      };
      const taskRunning = {
        id: "task-2",
        parent_task_id: null,
        title: "再試行後の自動調査ステップ",
        description: "",
        status: "running",
        status_reason: "Retried by owner",
        requires_approval: true,
        assigned_bot_id: "bot-grok",
        assigned_bot_name: "Grok Worker",
        retry_count: 1,
        version: 3,
        updated_at: Date.now(),
        active_lease: { bot_id: "bot-grok", expires_at: Date.now() + 60_000 },
      };
      const taskWaiting = {
        id: "task-1",
        parent_task_id: null,
        title: "認証方式の比較案まとめ",
        description: "",
        status: "waiting_human",
        status_reason: "判断カード回答待ち",
        requires_approval: true,
        assigned_bot_id: "bot-chatgpt",
        assigned_bot_name: "ChatGPT MCP",
        retry_count: 0,
        version: 2,
        updated_at: Date.now(),
        active_lease: null,
      };
      const taskDone = {
        id: "task-6",
        parent_task_id: null,
        title: "S0 ガードレール CI 基盤構築",
        description: "",
        status: "done",
        status_reason: null,
        requires_approval: true,
        assigned_bot_id: "bot-claude",
        assigned_bot_name: "Claude MCP",
        retry_count: 0,
        version: 5,
        updated_at: Date.now(),
        active_lease: null,
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspace: { id: "ws_1", is_paused: false, version: 1 },
          bots: [
            {
              id: "bot-grok",
              display_name: "Grok Worker",
              channel_type: "worker_bearer",
              status: "active",
              counts: {
                running: 1,
                waiting_human: 0,
                failed: task3Status === "failed" ? 1 : 0,
                blocked: 0,
                ready: task3Status === "ready" ? 1 : 0,
                done: 0,
              },
            },
          ],
          tasks: [taskFailed, taskRunning, taskWaiting, taskDone],
          columns: {
            ready: task3Status === "ready" ? [taskFailed] : [],
            running: [taskRunning],
            waiting_human: [taskWaiting],
            blocked: [],
            failed: task3Status === "failed" ? [taskFailed] : [],
            done: [taskDone],
          },
        }),
      });
    });

    await page.route("**/api/human/tasks/task-3/retry", async (route) => {
      task3Status = "ready";
      task3Version = 5;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          task_id: "task-3",
          version: 5,
          status: "ready",
          trace_id: "evt_retry_1",
        }),
      });
    });

    await page.goto("/board");
    await expect(page.getByTestId("board-bot-strip")).toBeVisible();
    await expect(page.getByTestId("board-task-reason-task-3")).toContainText("DLQ退避");
    await expect(page.getByTestId("board-task-retry-count-task-3")).toContainText(
      "再試行回数: 3回",
    );
    await expect(page.getByTestId("board-task-lease-task-2")).toContainText("WorkLease 占有中");

    // UX-01: Zero draggable elements and zero task editing inputs on /board
    expect(await page.locator('[draggable="true"]').count()).toBe(0);
    expect(await page.locator("input, textarea").count()).toBe(0);

    // Retry button appears ONLY on failed/blocked tasks, NOT on waiting_human or done
    await expect(page.getByTestId("btn-retry-task-task-3")).toBeVisible();
    await expect(page.getByTestId("btn-retry-task-task-1")).toHaveCount(0);
    await expect(page.getByTestId("btn-retry-task-task-6")).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // Click Retry -> moves task-3 from failed to ready!
    await page.getByTestId("btn-retry-task-task-3").click();
    await expect(page.getByTestId("btn-retry-task-task-3")).toHaveCount(0);
    await expect(
      page.getByTestId("kanban-col-ready").getByTestId("board-task-task-3"),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("renders /history with separated decision vs execution badges (BOT-03), filters, and cursor pagination", async ({
    page,
  }) => {
    await page.route("**/api/human/history*", async (route) => {
      const url = new URL(route.request().url());
      const filter = url.searchParams.get("filter") ?? "all";
      const cursor = url.searchParams.get("cursor");

      const failedItem = {
        decision_id: "dec_fail_1",
        card_id: "card_fail_1",
        task_id: "task_fail_1",
        task_title: "競合5アプリの誤スワイプ調査",
        proposal_title: "競合調査を実行する？",
        selection_mode: "binary",
        decision_result: "accepted",
        selected_option_ids: [],
        execution_status: "failed",
        execution_reason: "Upstream model timeout (DLQ)",
        bot_name: "Grok Worker",
        artifact: { id: "art_f1", title: "失敗ログ", version: 1 },
        finalized_at: Date.now() - 60_000,
      };
      const doneItem = {
        decision_id: "dec_done_1",
        card_id: "card_done_1",
        task_id: "task_done_1",
        task_title: "認証方式選定",
        proposal_title: "GitHub OAuth 単一オーナー",
        selection_mode: "single",
        decision_result: "accepted",
        selected_option_ids: ["opt-gh"],
        execution_status: "done",
        execution_reason: null,
        bot_name: "ChatGPT MCP",
        artifact: { id: "art_d1", title: "認証設計書", version: 2 },
        finalized_at: Date.now() - 120_000,
      };

      if (filter === "failed") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [failedItem], next_cursor: null }),
        });
        return;
      }

      if (cursor === "page-2") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [doneItem], next_cursor: null }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [failedItem], next_cursor: "page-2" }),
      });
    });

    await page.goto("/history");
    await expect(page.getByTestId("history-decision-badge-dec_fail_1")).toContainText("採用確定");
    await expect(page.getByTestId("history-exec-badge-dec_fail_1")).toContainText(
      "実行失敗 (BOT-03)",
    );
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // Cursor pagination loads page 2
    await page.getByTestId("history-load-more-btn").click();
    await expect(page.getByTestId("history-item-dec_done_1")).toBeVisible();
    await expect(page.getByTestId("history-exec-badge-dec_done_1")).toContainText("実行完了");

    // Filter to failed only
    await page.getByTestId("history-filter-failed").click();
    await expect(page.getByTestId("history-item-dec_fail_1")).toBeVisible();
    await expect(page.getByTestId("history-item-dec_done_1")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
  });

  test("enforces structured budget_limit (incl. blank rejection), VERSION_CONFLICT reload, scope toggle + 0-scope guard, Worker Bearer 1-time issue, 2-step revocation confirmation, and honest external status on /settings", async ({
    page,
  }) => {
    let workspace = {
      id: "ws_1",
      goal: "",
      allowed_scope: "",
      budget_limit: {
        max_cards_per_day: 20,
        max_steps_per_task: 10,
        daily_cost_limit_cents: 300,
      },
      is_paused: false,
      version: 1,
      updated_at: Date.now(),
    };
    let bots = [
      {
        id: "bot_1",
        display_name: "Grok Worker #1",
        channel_type: "worker_bearer",
        oauth_client_id: null,
        scopes: ["tasks:read", "tasks:write"],
        status: "active",
        version: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];
    let revokePatchCalls = 0;
    let triggerConflictOnce = true;

    await page.route("**/api/human/workspace", async (route) => {
      if (route.request().method() === "PATCH") {
        if (triggerConflictOnce) {
          triggerConflictOnce = false;
          workspace = { ...workspace, version: 2 };
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              code: "VERSION_CONFLICT",
              message: "別の端末で設定が更新されました。",
              retryable: false,
            }),
          });
          return;
        }
        const raw: unknown = route.request().postDataJSON();
        const body =
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? Object.fromEntries(Object.entries(raw))
            : {};
        const rawBudget: unknown = body["budget_limit"];
        const budgetObj: Record<string, unknown> | null =
          rawBudget !== null && typeof rawBudget === "object" && !Array.isArray(rawBudget)
            ? Object.fromEntries(Object.entries(rawBudget))
            : null;
        workspace = {
          ...workspace,
          ...(typeof body["goal"] === "string" ? { goal: body["goal"] } : {}),
          ...(typeof body["allowed_scope"] === "string"
            ? { allowed_scope: body["allowed_scope"] }
            : {}),
          ...(budgetObj !== null &&
          typeof budgetObj["max_cards_per_day"] === "number" &&
          typeof budgetObj["max_steps_per_task"] === "number" &&
          typeof budgetObj["daily_cost_limit_cents"] === "number"
            ? {
                budget_limit: {
                  max_cards_per_day: budgetObj["max_cards_per_day"],
                  max_steps_per_task: budgetObj["max_steps_per_task"],
                  daily_cost_limit_cents: budgetObj["daily_cost_limit_cents"],
                },
              }
            : {}),
          ...(typeof body["is_paused"] === "boolean" ? { is_paused: body["is_paused"] } : {}),
          version: workspace.version + 1,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workspace),
      });
    });

    await page.route("**/api/human/bots", async (route) => {
      if (route.request().method() === "POST") {
        const created = {
          bot_id: "bot_2",
          display_name: "Grok Worker #2",
          channel_type: "worker_bearer",
          scopes: ["tasks:read", "tasks:write"],
          status: "active",
          version: 1,
          bearer_token: "bbw_one_time_plaintext_secret_token",
          trace_id: "evt_bot_2",
        };
        bots = [
          ...bots,
          {
            id: created.bot_id,
            display_name: created.display_name,
            channel_type: "worker_bearer",
            oauth_client_id: null,
            scopes: created.scopes,
            status: "active",
            version: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(created),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: bots }),
      });
    });

    await page.route("**/api/human/bots/bot_1", async (route) => {
      const raw: unknown = route.request().postDataJSON();
      const body =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? Object.fromEntries(Object.entries(raw))
          : {};
      if (body["status"] === "revoked") {
        revokePatchCalls += 1;
      }
      bots = bots.map((b) =>
        b.id === "bot_1"
          ? {
              ...b,
              ...(typeof body["status"] === "string" ? { status: body["status"] } : {}),
              ...(Array.isArray(body["scopes"]) ? { scopes: body["scopes"] } : {}),
              version: b.version + 1,
            }
          : b,
      );
      const updated = bots.find((b) => b.id === "bot_1");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          bot_id: "bot_1",
          display_name: updated?.display_name ?? "Grok Worker #1",
          channel_type: "worker_bearer",
          scopes: updated?.scopes ?? [],
          status: updated?.status ?? "active",
          version: updated?.version ?? 2,
          trace_id: "evt_patch_1",
        }),
      });
    });

    let passkeys = [
      {
        id: "pk_iphone_1",
        name: "iPhone (Face ID)",
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: "2026-11-20T00:00:00.000Z",
      },
    ];
    let passkeyDeleteCalls = 0;
    let failPasskeysOnce = true;

    await page.route("**/api/auth/passkey/list-user-passkeys", async (route) => {
      if (failPasskeysOnce) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "Temporary passkey store error" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(passkeys),
      });
    });

    await page.route("**/api/auth/passkey/delete-passkey", async (route) => {
      passkeyDeleteCalls += 1;
      const raw: unknown = route.request().postDataJSON();
      const id: unknown =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? Reflect.get(raw, "id")
          : null;
      if (typeof id === "string") {
        passkeys = passkeys.filter((item) => item.id !== id);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: true }),
      });
    });

    await page.goto("/settings");
    await expect(page.getByTestId("settings-passkeys-section")).toBeVisible();
    await expect(page.getByTestId("settings-error-banner")).toBeVisible();
    await expect(page.getByTestId("settings-passkeys-error")).toBeVisible();
    await expect(page.getByTestId("passkey-count-badge")).toContainText("取得失敗");
    await expect(page.getByTestId("settings-passkeys-empty")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // Reloading after list-user-passkeys recovers clears error and renders registered passkey
    failPasskeysOnce = false;
    await page.getByTestId("btn-settings-error-reload").click();
    await expect(page.getByTestId("settings-passkeys-error")).toHaveCount(0);
    await expect(page.getByTestId("settings-onboarding")).toBeVisible();
    await expect(page.getByTestId("passkey-count-badge")).toContainText("1 件登録済");
    await expect(page.getByTestId("settings-passkey-pk_iphone_1")).toContainText(
      "iPhone (Face ID)",
    );
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // 2-step passkey delete: Cancel must not delete; Confirm deletes and updates badge to 0
    await page.getByTestId("btn-request-delete-passkey-pk_iphone_1").click();
    await expect(page.getByTestId("passkey-delete-confirm-pk_iphone_1")).toBeVisible();
    await assertAllVisibleButtonsAtLeast44px(page);
    await page.getByTestId("btn-cancel-delete-passkey-pk_iphone_1").click();
    await expect(page.getByTestId("passkey-delete-confirm-pk_iphone_1")).toHaveCount(0);
    expect(passkeyDeleteCalls).toBe(0);

    await page.getByTestId("btn-request-delete-passkey-pk_iphone_1").click();
    await page.getByTestId("btn-confirm-delete-passkey-pk_iphone_1").click();
    await expect(page.getByTestId("settings-passkeys-empty")).toBeVisible();
    await expect(page.getByTestId("passkey-count-badge")).toContainText("0 件登録済");
    expect(passkeyDeleteCalls).toBe(1);

    // Never claim unverified external Bot channels as 対応済
    await expect(page.getByTestId("settings-page")).not.toContainText("対応済");

    // Blank cost input MUST be rejected (not silently coerced to $0.00!)
    await page.getByTestId("input-budget-cost").fill("");
    await page.getByTestId("btn-save-workspace").click();
    await expect(page.getByTestId("settings-error-banner")).toContainText("空欄にできません");

    // Out-of-range cards (0) rejected client-side
    await page.getByTestId("input-budget-cost").fill("4.50");
    await page.getByTestId("input-budget-cards").fill("0");
    await page.getByTestId("btn-save-workspace").click();
    await expect(page.getByTestId("settings-error-banner")).toBeVisible();

    // VERSION_CONFLICT surfaces reload CTA and recovers cleanly
    await page.getByTestId("input-budget-cards").fill("25");
    await page.getByTestId("input-workspace-goal").fill("MVP完成");
    await page.getByTestId("btn-save-workspace").click();
    await expect(page.getByTestId("settings-error-banner")).toContainText("更新されました");
    await page.getByTestId("btn-settings-error-reload").click();
    await expect(page.getByTestId("settings-error-banner")).toHaveCount(0);

    // Valid structured budget_limit saves cleanly and persists updated values
    await page.getByTestId("input-budget-cards").fill("25");
    await page.getByTestId("input-budget-cost").fill("4.50");
    await page.getByTestId("input-workspace-goal").fill("MVP完成");
    await page.getByTestId("btn-save-workspace").click();
    await expect(page.getByTestId("settings-onboarding")).toHaveCount(0);
    expect(workspace.budget_limit.max_cards_per_day).toBe(25);
    expect(workspace.budget_limit.daily_cost_limit_cents).toBe(450);

    // Emergency pause toggle works
    await page.getByTestId("btn-toggle-workspace-pause").click();
    await expect(page.getByTestId("settings-paused-banner")).toBeVisible();

    // Bot scope toggle works AND 0-scope guard prevents removing the last remaining scope
    await page.getByTestId("bot-scope-bot_1-tasks:write").click();
    await expect(page.getByTestId("bot-scope-bot_1-tasks:write")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.getByTestId("bot-scope-bot_1-tasks:read").click();
    await expect(page.getByTestId("settings-error-banner")).toContainText("最低 1 つ");

    // 1-time Worker Bearer issuance displays plaintext token once
    await page.getByTestId("btn-open-issue-worker").click();
    await page.getByTestId("input-new-bot-name").fill("Grok Worker #2");
    await page.getByTestId("btn-submit-issue-worker").click();
    await expect(page.getByTestId("issued-bearer-banner")).toContainText(
      "bbw_one_time_plaintext_secret_token",
    );

    // 2-step confirmation for irreversible revocation:
    await page.getByTestId("btn-request-revoke-bot_1").click();
    await expect(page.getByTestId("revoke-confirm-box-bot_1")).toBeVisible();
    expect(revokePatchCalls).toBe(0);

    // Cancel aborts revocation without issuing PATCH
    await page.getByTestId("btn-cancel-revoke-bot_1").click();
    await expect(page.getByTestId("revoke-confirm-box-bot_1")).toHaveCount(0);
    expect(revokePatchCalls).toBe(0);

    // Copyable Remote MCP Endpoint URL box & >=44px Copy button are visible in Bot Connections
    await expect(page.getByTestId("settings-mcp-endpoint-box")).toBeVisible();
    await expect(page.getByTestId("settings-mcp-endpoint-url")).toContainText("/api/mcp");
    await expect(page.getByTestId("btn-copy-mcp-url")).toBeVisible();

    // Confirm executes PATCH status=revoked and disables controls (await status BEFORE asserting count)
    await page.getByTestId("btn-request-revoke-bot_1").click();
    await page.getByTestId("btn-confirm-revoke-bot_1").click();
    await expect(page.getByTestId("settings-bot-status-bot_1")).toHaveText("revoked");
    expect(revokePatchCalls).toBe(1);
    await expect(page.getByTestId("btn-pause-bot-bot_1")).toBeDisabled();
    await expect(page.getByTestId("btn-request-revoke-bot_1")).toBeDisabled();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // Owner Sign-Out button calls POST /api/auth/sign-out and navigates to /sign-in
    let signOutCalled = false;
    await page.route("**/api/auth/sign-out", async (route) => {
      signOutCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });
    await page.route("**/api/auth/owner-status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ initialized: true }),
      });
    });
    await page.unroute("**/api/human/workspace");
    await page.route("**/api/human/workspace", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "NOT_AUTHORIZED", message: "Sign-in required" }),
      });
    });
    await page.getByTestId("btn-settings-sign-out").click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(signOutCalled).toBe(true);
  });
});
