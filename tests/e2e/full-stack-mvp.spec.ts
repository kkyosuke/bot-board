import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

interface ResetResponse {
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly ownerCookieName: string;
  readonly ownerCookieValue: string;
}

interface FlushResponse {
  readonly finalizedProcessed: number;
  readonly botWorkProcessed: number;
  readonly dlqProcessed: number;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function assertAllVisibleButtonsAtLeast44px(page: Page): Promise<void> {
  const buttons = page.locator("button:visible");
  const count = await buttons.count();
  let checkedCount = 0;

  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const isInertOrHidden = await button.evaluate(
      (el) => el.closest("[inert], [aria-hidden='true']") !== null,
    );
    if (isInertOrHidden) {
      continue;
    }
    checkedCount += 1;
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      const label =
        (await button.getAttribute("data-testid")) ??
        (await button.getAttribute("aria-label")) ??
        (await button.innerText());
      expect(box.width, `button "${label}" width >= 44px`).toBeGreaterThanOrEqual(44);
      expect(box.height, `button "${label}" height >= 44px`).toBeGreaterThanOrEqual(44);
    }
  }
  expect(checkedCount).toBeGreaterThan(0);
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw));
  }
  throw new Error(`Expected JSON object, received: ${JSON.stringify(raw)}`);
}

async function resetFullStack(request: APIRequestContext, baseURL: string): Promise<ResetResponse> {
  const res = await request.post(`${baseURL}/__fullstack/reset`);
  expect(res.ok()).toBe(true);
  const obj = parseJsonObject(await res.json());
  return {
    ownerUserId: String(obj["ownerUserId"]),
    workspaceId: String(obj["workspaceId"]),
    ownerCookieName: String(obj["ownerCookieName"]),
    ownerCookieValue: String(obj["ownerCookieValue"]),
  };
}

async function flushQueues(
  request: APIRequestContext,
  baseURL: string,
  advanceMs: number,
): Promise<FlushResponse> {
  const res = await request.post(`${baseURL}/__fullstack/flush-queues`, {
    data: { advanceMs },
  });
  expect(res.ok()).toBe(true);
  const obj = parseJsonObject(await res.json());
  return {
    finalizedProcessed: Number(obj["finalizedProcessed"] ?? 0),
    botWorkProcessed: Number(obj["botWorkProcessed"] ?? 0),
    dlqProcessed: Number(obj["dlqProcessed"] ?? 0),
  };
}

async function callMcpRaw(
  request: APIRequestContext,
  baseURL: string,
  token: string | null,
  body: Record<string, unknown>,
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await request.post(`${baseURL}/api/mcp`, {
    headers,
    data: body,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.trim().startsWith("event:") || text.includes("\ndata:")) {
    const dataLine = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    parsed = dataLine !== undefined ? JSON.parse(dataLine) : null;
  } else if (text.trim() !== "") {
    parsed = JSON.parse(text);
  }
  return { status: res.status(), headers: res.headers(), json: parsed };
}

async function callMcpToolExpectError(
  request: APIRequestContext,
  baseURL: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await callMcpRaw(request, baseURL, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  const rpc = parseJsonObject(res.json);
  const result = parseJsonObject(rpc["result"]);
  expect(result["isError"]).toBe(true);
  return JSON.stringify(result["content"]);
}

async function callMcpTool(
  request: APIRequestContext,
  baseURL: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await callMcpRaw(request, baseURL, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  const rpc = parseJsonObject(res.json);
  const result = parseJsonObject(rpc["result"]);
  if (result["isError"] === true) {
    throw new Error(`MCP tool ${name} returned error: ${JSON.stringify(result["content"])}`);
  }
  const content: unknown = result["content"];
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`Expected MCP content array for tool ${name}`);
  }
  const first = parseJsonObject(content[0]);
  const text = first["text"];
  if (typeof text !== "string") {
    throw new Error(`Expected text payload for tool ${name}`);
  }
  return parseJsonObject(JSON.parse(text));
}

async function issueWorkerBearerViaSettingsUi(page: Page, displayName: string): Promise<string> {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByTestId("btn-open-issue-worker").click();
  await page.getByTestId("input-new-bot-name").fill(displayName);
  await page.getByTestId("btn-submit-issue-worker").click();
  const banner = page.getByTestId("issued-bearer-banner");
  await expect(banner).toBeVisible();
  const tokenText = await banner.locator(".font-mono").innerText();
  const trimmed = tokenText.trim();
  expect(trimmed.startsWith("bbw_")).toBe(true);
  return trimmed;
}

test.describe("S8 Full-Stack Vertical MVP E2E — All 12 ACs (UX-01..05, DEC-01..04, BOT-01..03)", () => {
  test("Scenario 1 (First Real-World Journey): Onboarding -> Cross-Viewport Same Card (UX-02) -> UX-03/04/05 Real Gestures & Keyboard -> Queue Auto-Resume (BOT-01) -> Deliverable Swipe -> /board & /history", async ({
    page,
    browser,
    request,
    baseURL,
    viewport,
  }, testInfo) => {
    const resolvedBase = baseURL ?? "http://127.0.0.1:4174";
    const session = await resetFullStack(request, resolvedBase);

    // BOT-02: Unauthenticated / redirects to /sign-in, and unauthenticated /api/mcp returns 401 WWW-Authenticate
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);
    const unauthMcp = await callMcpRaw(request, resolvedBase, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(unauthMcp.status).toBe(401);
    expect(unauthMcp.headers["www-authenticate"]).toContain("Bearer");

    // Authenticate owner via real Better Auth signed session cookie
    const ownerCookie = {
      name: session.ownerCookieName,
      value: session.ownerCookieValue,
      url: resolvedBase,
      httpOnly: true,
      sameSite: "Lax" as const,
    };
    await page.context().addCookies([ownerCookie]);

    // UX-01: First-time setup on /settings (goal, allowed_scope, structured budget_limit) + issue 1-time Worker Bearer
    await page.goto("/settings");
    await expect(page.getByTestId("settings-onboarding")).toBeVisible();
    await page.getByTestId("input-workspace-goal").fill("アプリ企画・競合調査とMVP開発");
    await page.getByTestId("input-workspace-scope").fill("タスク分解・競合調査・設計下書き");
    await page.getByTestId("input-budget-cards").fill("30");
    await page.getByTestId("input-budget-steps").fill("10");
    await page.getByTestId("input-budget-cost").fill("5.00");
    await page.getByTestId("btn-save-workspace").click();
    await expect(page.getByTestId("settings-page")).toContainText(
      "ワークスペース設定を保存しました",
    );
    await expect(page.getByTestId("settings-onboarding")).toBeVisible();

    // Honest external Bot matrix never claims 対応済
    await expect(page.getByTestId("settings-page")).not.toContainText("対応済");

    const workerToken = await issueWorkerBearerViaSettingsUi(page, "Grok Local Worker");
    await expect(page.getByTestId("settings-onboarding")).toHaveCount(0);

    // BOT-02: Verify /api/mcp exposes exact 12 Bot tools and zero human approval tools
    const toolsListRes = await callMcpRaw(request, resolvedBase, workerToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(toolsListRes.status).toBe(200);
    const toolsResult = parseJsonObject(parseJsonObject(toolsListRes.json)["result"]);
    const rawTools: unknown = toolsResult["tools"];
    expect(Array.isArray(rawTools)).toBe(true);
    if (Array.isArray(rawTools)) {
      expect(rawTools).toHaveLength(12);
      const toolNames = rawTools.map((t) => String(parseJsonObject(t)["name"]));
      expect(toolNames).not.toContain("decide_card");
      expect(toolNames).not.toContain("approve_card");
    }

    // Real Bot workflow over /api/mcp: create_task -> claim_task -> submit_proposal (single-choice 3 options)
    const createdTask = await callMcpTool(request, resolvedBase, workerToken, 3, "create_task", {
      request_id: "fs-create-1",
      title: "アプリ企画・競合調査",
      description: "主要3アプリのスマホ片手スワイプ比較と初版スコープ提案",
      requires_approval: true,
    });
    const taskId = String(createdTask["task_id"]);
    const claimed = await callMcpTool(request, resolvedBase, workerToken, 4, "claim_task", {
      request_id: "fs-claim-1",
      task_id: taskId,
      expected_version: Number(createdTask["version"]),
      lease_duration_seconds: 120,
    });
    const policyProp = await callMcpTool(request, resolvedBase, workerToken, 5, "submit_proposal", {
      request_id: "fs-prop-1",
      task_id: taskId,
      expected_version: Number(claimed["version"]),
      lease_token: String(claimed["lease_token"]),
      artifact: {
        title: "競合調査・企画ドラフト",
        kind: "markdown",
        summary: "3社の片手操作・承認フロー比較メモ",
        content_or_url:
          "# 競合比較メモ\n1. A社: 2択のみ\n2. B社: フォーム編集必須\n3. bot-board: カード内選択＋統一スワイプ",
      },
      proposals: [
        {
          card_type: "policy",
          selection_mode: "single",
          options: [
            {
              id: "opt-sp-mvp",
              title: "案A：SP片手スワイプMVPへ集中",
              badge: "推奨",
              summary: "タスク編集ゼロで判断カード体験を最優先",
              meta: "工数小",
              recommended: true,
            },
            {
              id: "opt-full-kanban",
              title: "案B：フル編集カンバン先行",
              summary: "PC管理画面を先に構築",
              meta: "工数大",
            },
            {
              id: "opt-chat-only",
              title: "案C：チャット通知のみ",
              summary: "専用カードUIを省略",
              meta: "体験弱",
            },
          ],
          title: "初版はスマホの判断カードに機能を絞る？",
          summary: "競合調査結果に基づき、初版MVPの方針を選択してください。",
          on_accept_effect: "選択した方針で成果ドラフト作成を自動再開",
          on_decline_effect: "全案見送りとして代替方針を再提案",
          on_decline_policy: "revise",
          factors: [
            { label: "対象", value: "SP 360px / PC" },
            { label: "次工程", value: "Queue 自動再開" },
          ],
        },
      ],
    });
    const policyCards: unknown = policyProp["cards"];
    const policyCardId =
      Array.isArray(policyCards) && policyCards[0] !== undefined
        ? String(parseJsonObject(policyCards[0])["card_id"])
        : "";
    expect(policyCardId).not.toBe("");

    // BOT-02: Bot Bearer token MUST NOT be able to forge a human decision on /api/human/*
    const forgedDecideRes = await request.post(
      `${resolvedBase}/api/human/cards/${policyCardId}/decide`,
      {
        headers: { Authorization: `Bearer ${workerToken}`, Origin: resolvedBase },
        data: {
          request_id: "forged-bot-decide-1",
          expected_version: 1,
          payload: { mode: "single", decision: "accepted", selectedOptionId: "opt-sp-mvp" },
        },
      },
    );
    expect(forgedDecideRes.status()).toBe(401);

    // UX-01 / UX-02 / UX-03: Owner opens live / (ZERO task editing!)
    await page.goto("/");
    const topCard = page.getByTestId("top-decision-card");
    await expect(topCard).toBeVisible();
    await expect(topCard).toHaveAttribute("data-card-id", policyCardId);
    await expect(page.getByTestId("card-headline")).toContainText(
      "初版はスマホの判断カードに機能を絞る？",
    );
    await expect(page.getByTestId("outcome-accept")).toContainText(
      "選択した方針で成果ドラフト作成を自動再開",
    );
    await expect(page.getByTestId("outcome-decline")).toContainText(
      "全案見送りとして代替方針を再提案",
    );
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // UX-02: Verify the EXACT SAME live card is readable across PC and SP viewports simultaneously (no DB reset!)
    const companionIsMobile = testInfo.project.name === "pc-desktop";
    const companionContext = await browser.newContext({
      baseURL: resolvedBase,
      viewport: companionIsMobile ? { width: 360, height: 780 } : { width: 1280, height: 800 },
      hasTouch: companionIsMobile,
      isMobile: companionIsMobile,
    });
    try {
      await companionContext.addCookies([ownerCookie]);
      const companionPage = await companionContext.newPage();
      await companionPage.goto("/");
      await expect(companionPage.getByTestId("top-decision-card")).toHaveAttribute(
        "data-card-id",
        policyCardId,
      );
      await expect(companionPage.getByTestId("card-headline")).toContainText(
        "初版はスマホの判断カードに機能を絞る？",
      );
      await assertNoHorizontalOverflow(companionPage);
    } finally {
      await companionContext.close();
    }

    // UX-04 (M1): Start drags on genuinely draggable `card-headline` (NOT data-no-drag radio buttons!) and assert gesture-hint feedback!
    const headlineBox = await page.getByTestId("card-headline").boundingBox();
    const topCardBox = await topCard.boundingBox();
    expect(headlineBox).not.toBeNull();
    expect(topCardBox).not.toBeNull();
    if (headlineBox !== null && topCardBox !== null) {
      const dragX = headlineBox.x + headlineBox.width / 2;
      const dragY = headlineBox.y + headlineBox.height / 2;

      // 1) Vertical scroll dominant drag -> locks vertical scroll, zero submission
      await page.mouse.move(dragX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragX + 12, dragY - 90, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId("gesture-hint")).toContainText("縦スクロール優先中");
      await expect(page.getByTestId("undo-banner")).toHaveCount(0);

      // 2) Sub-threshold horizontal drag (~40px < 84px threshold) -> springs back without submitting
      await page.mouse.move(dragX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragX + 40, dragY + 2, { steps: 10 });
      await page.mouse.up();
      await expect(page.getByTestId("gesture-hint")).toContainText(
        "閾値未満のため未送信で戻しました",
      );
      await expect(page.getByTestId("undo-banner")).toHaveCount(0);

      // 3) SP 24px screen-edge protection (<768px): wait for spring-back to settle, then drag +160px from inside left 24px edge
      if (viewport !== null && viewport.width < 768) {
        await expect
          .poll(async () => Math.abs(((await topCard.boundingBox())?.x ?? 999) - topCardBox.x))
          .toBeLessThan(2);
        const edgeX = topCardBox.x + 8;
        await page.mouse.move(edgeX, dragY);
        await page.mouse.down();
        await page.mouse.move(edgeX + 160, dragY, { steps: 10 });
        await page.mouse.up();
        await expect(page.getByTestId("gesture-hint")).toContainText(
          "画面端24pxはOS戻るジェスチャーを優先しました",
        );
        await expect(page.getByTestId("undo-banner")).toHaveCount(0);
      }
    }
    await expect(page.getByTestId("card-headline")).toContainText(
      "初版はスマホの判断カードに機能を絞る？",
    );

    // UX-05: Select option & commit (keyboard 2 -> 1 -> ArrowRight -> Z undo -> ArrowRight on PC; button on SP)
    if (testInfo.project.name === "pc-desktop") {
      await page.keyboard.press("2");
      await expect(page.getByTestId("option-radio-opt-full-kanban")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("1");
      await expect(page.getByTestId("option-radio-opt-sp-mvp")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("undo-banner")).toBeVisible();
      await page.keyboard.press("z");
      await expect(page.getByTestId("undo-banner")).toHaveCount(0);
      await expect(page.getByTestId("option-radio-opt-sp-mvp")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("ArrowRight");
    } else {
      await page.getByTestId("option-radio-opt-sp-mvp").click();
      await page.getByTestId("btn-accept").click();
    }
    await expect(page.getByTestId("undo-banner")).toBeVisible();

    // BOT-01: Flush 5s decision-finalize -> bot-work Queue -> Worker autonomously produces deliverable card WITHOUT any chat input!
    const flush1 = await flushQueues(request, resolvedBase, 6_000);
    expect(flush1.finalizedProcessed).toBeGreaterThanOrEqual(1);
    expect(flush1.botWorkProcessed).toBeGreaterThanOrEqual(1);

    // UX-05: Verify prefers-reduced-motion compatibility on live deliverable card + UX-03 binary outcomes!
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByTestId("card-headline")).toContainText("成果ドラフト");
    await expect(page.getByTestId("outcome-accept")).toBeVisible();
    await expect(page.getByTestId("outcome-decline")).toBeVisible();
    await assertAllVisibleButtonsAtLeast44px(page);

    const openDetailBtn = page.getByTestId("btn-open-detail");
    if (await openDetailBtn.isVisible()) {
      await openDetailBtn.click();
    }
    await expect(page.getByTestId("detail-artifact-full").first()).toContainText(
      "Queue ワーカーが自律再開して本成果を生成",
    );
    const closeSheetBtn = page.getByTestId("btn-close-sheet");
    if (await closeSheetBtn.isVisible()) {
      await closeSheetBtn.click();
    }

    // UX-01 / UX-05: Accept deliverable via real horizontal right-swipe gesture on draggable card-headline (> 84px threshold) -> finalize -> done!
    const delivHeadlineBox = await page.getByTestId("card-headline").boundingBox();
    expect(delivHeadlineBox).not.toBeNull();
    if (delivHeadlineBox !== null) {
      const sx = Math.max(delivHeadlineBox.x + 30, 40);
      const sy = delivHeadlineBox.y + delivHeadlineBox.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 160, sy + 3, { steps: 10 });
      await page.mouse.up();
    }
    await expect(page.getByTestId("undo-banner")).toBeVisible();
    await flushQueues(request, resolvedBase, 6_000);

    // Verify /board (read-only Kanban UX-01: zero draggable, zero inputs) shows task in done column!
    await page.goto("/board");
    expect(await page.locator('[draggable="true"]').count()).toBe(0);
    expect(await page.locator("input, textarea").count()).toBe(0);
    await expect(
      page.getByTestId("kanban-col-done").getByTestId(`board-task-${taskId}`),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // Verify /history shows finalized decisions with separated badges (採用確定 + 実行完了)
    await page.goto("/history");
    await expect(page.getByTestId("history-list")).toContainText("採用確定");
    await expect(page.getByTestId("history-list")).toContainText("実行完了");
    await expect(page.getByTestId("history-list")).toContainText("アプリ企画・競合調査");
    await assertNoHorizontalOverflow(page);
  });

  test("Scenario 2 (Conflicts, Exclusivity, Failure & Security): DEC-01 Undo, DEC-02 /decide Idempotency & 2-Terminal Race, DEC-03 STALE_PROPOSAL, DEC-04 GROUP_LOCKED/Sibling Close/All-Declined Revise, Multi+Cron, BOT-03 DLQ+Retry, BOT-02 Pause/Scope/Revoke", async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const resolvedBase = baseURL ?? "http://127.0.0.1:4174";
    const session = await resetFullStack(request, resolvedBase);
    const cookieHeader = `${session.ownerCookieName}=${session.ownerCookieValue}`;

    await page.context().addCookies([
      {
        name: session.ownerCookieName,
        value: session.ownerCookieValue,
        url: resolvedBase,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const workerToken = await issueWorkerBearerViaSettingsUi(page, "Grok Guard Worker");

    // -------------------------------------------------------------------------
    // 1) DEC-01 + DEC-04: 2-card candidate group -> GROUP_LOCKED (409) -> Undo restores -> Single decline stays waiting_human -> All-declined revise ([代替案])
    // -------------------------------------------------------------------------
    const tGroup = await callMcpTool(request, resolvedBase, workerToken, 10, "create_task", {
      request_id: "s2-create-grp",
      title: "候補グループ＆見送り改訂検証",
      description: "2案の排他選択と見送り後自動再提案の検証",
      requires_approval: true,
    });
    const grpTaskId = String(tGroup["task_id"]);
    const cGroup = await callMcpTool(request, resolvedBase, workerToken, 11, "claim_task", {
      request_id: "s2-claim-grp",
      task_id: grpTaskId,
      expected_version: Number(tGroup["version"]),
      lease_duration_seconds: 120,
    });
    const propGroup = await callMcpTool(request, resolvedBase, workerToken, 12, "submit_proposal", {
      request_id: "s2-prop-grp",
      task_id: grpTaskId,
      expected_version: Number(cGroup["version"]),
      lease_token: String(cGroup["lease_token"]),
      selection_group_id: "grp-fs-exclusivity",
      proposals: [
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "候補1：週次ダイジェスト方式を採用する？",
          summary: "案1の比較概要",
          on_accept_effect: "候補1で進める（候補2を排他クローズ）",
          on_decline_effect: "候補1を見送り（候補2が残る）",
          on_decline_policy: "revise",
          factors: [],
        },
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "候補2：リアルタイム通知方式を採用する？",
          summary: "案2の比較概要",
          on_accept_effect: "候補2で進める（候補1を排他クローズ）",
          on_decline_effect: "全案見送り→代替案を自動再提案",
          on_decline_policy: "revise",
          factors: [],
        },
      ],
    });
    const rawCards: unknown = propGroup["cards"];
    expect(Array.isArray(rawCards) && rawCards.length === 2).toBe(true);
    const groupCardIds = Array.isArray(rawCards)
      ? rawCards.map((c) => String(parseJsonObject(c)["card_id"]))
      : [];
    expect(groupCardIds).toHaveLength(2);

    await page.goto("/");
    await expect(page.getByTestId("remaining-badge")).toContainText("残り 2");
    await expect(page.getByTestId("outcome-accept")).toBeVisible();
    await expect(page.getByTestId("outcome-decline")).toBeVisible();

    // Determine ACTUAL top card & sibling dynamically via data-card-id (never assume ordering)
    const activeGroupCardId = await page
      .getByTestId("top-decision-card")
      .getAttribute("data-card-id");
    expect(activeGroupCardId).not.toBeNull();
    const siblingGroupCardId = groupCardIds.find((id) => id !== activeGroupCardId) ?? "";
    expect(siblingGroupCardId).not.toBe("");

    // Accept top card -> sibling temporarily hidden + locked -> competing POST /decide on sibling returns 409 GROUP_LOCKED!
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("undo-banner")).toBeVisible();
    await expect(page.getByTestId("remaining-badge")).toContainText("残り 0");

    const siblingLockRes = await request.post(
      `${resolvedBase}/api/human/cards/${siblingGroupCardId}/decide`,
      {
        headers: { Cookie: cookieHeader, Origin: resolvedBase },
        data: {
          request_id: "s2-group-locked-attempt",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      },
    );
    expect(siblingLockRes.status()).toBe(409);
    expect(parseJsonObject(await siblingLockRes.json())["code"]).toBe("GROUP_LOCKED");

    // DEC-01: Undo within 5s restores BOTH cards & Bot NEVER observes undone decision
    await page.getByTestId("btn-undo").click();
    await expect(page.getByTestId("remaining-badge")).toContainText("残り 2");
    const flushAfterUndo = await flushQueues(request, resolvedBase, 6_000);
    expect(flushAfterUndo.botWorkProcessed).toBe(0);
    const decisionsAfterUndo = await callMcpTool(
      request,
      resolvedBase,
      workerToken,
      13,
      "list_decision_results",
      { task_id: grpTaskId },
    );
    const undoneItems: unknown = decisionsAfterUndo["items"];
    expect(Array.isArray(undoneItems) ? undoneItems.length : -1).toBe(0);

    // DEC-04: Decline ONLY 1 of 2 candidates -> task remains waiting_human (zero bot-work, zero auto-adopt!)
    if (testInfo.project.name === "pc-desktop") {
      await page.keyboard.press("ArrowLeft");
    } else {
      await page.getByTestId("btn-decline").click();
    }
    await expect(page.getByTestId("remaining-badge")).toContainText("残り 1");
    const flushAfterOneDecline = await flushQueues(request, resolvedBase, 6_000);
    expect(flushAfterOneDecline.botWorkProcessed).toBe(0);

    // Decline 2nd candidate WITHOUT any decline-reason input -> zero auto-adoption, Worker auto-generates [代替案] card!
    await page.getByTestId("btn-decline").click();
    await expect(page.getByTestId("remaining-badge")).toContainText("残り 0");
    const flushAllDeclined = await flushQueues(request, resolvedBase, 6_000);
    expect(flushAllDeclined.botWorkProcessed).toBeGreaterThanOrEqual(1);

    const declinedResults = await callMcpTool(
      request,
      resolvedBase,
      workerToken,
      14,
      "list_decision_results",
      { task_id: grpTaskId },
    );
    const declinedList: unknown = declinedResults["items"];
    expect(Array.isArray(declinedList)).toBe(true);
    if (Array.isArray(declinedList)) {
      expect(declinedList.some((d) => parseJsonObject(d)["result"] === "accepted")).toBe(false);
    }

    await page.goto("/");
    await expect(page.getByTestId("card-headline")).toContainText("代替案");

    // DEC-03: Bump underlying task version -> clicking Accept returns real 409 STALE_PROPOSAL & UI switches to [再確認] card!
    const bumpRes = await request.post(`${resolvedBase}/__fullstack/bump-task-version`, {
      data: { task_id: grpTaskId },
    });
    expect(bumpRes.ok()).toBe(true);
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("card-headline")).toContainText("[再確認]");

    // -------------------------------------------------------------------------
    // 2) DEC-04 (M2): Candidate group acceptance permanently closes sibling (status = "closed")
    // -------------------------------------------------------------------------
    const tGrpAccept = await callMcpTool(request, resolvedBase, workerToken, 20, "create_task", {
      request_id: "s2-create-grp-accept",
      title: "候補グループ採用クローズ検証",
      description: "1案採用確定で残候補が closed になることを検証",
      requires_approval: true,
    });
    const grpAcceptTaskId = String(tGrpAccept["task_id"]);
    const cGrpAccept = await callMcpTool(request, resolvedBase, workerToken, 21, "claim_task", {
      request_id: "s2-claim-grp-accept",
      task_id: grpAcceptTaskId,
      expected_version: Number(tGrpAccept["version"]),
      lease_duration_seconds: 120,
    });
    const pGrpAccept = await callMcpTool(
      request,
      resolvedBase,
      workerToken,
      22,
      "submit_proposal",
      {
        request_id: "s2-prop-grp-accept",
        task_id: grpAcceptTaskId,
        expected_version: Number(cGrpAccept["version"]),
        lease_token: String(cGrpAccept["lease_token"]),
        selection_group_id: "grp-fs-accept-close",
        proposals: [
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "採用グループ案A",
            summary: "案Aを採用",
            on_accept_effect: "案A確定・案Bを自動クローズ",
            on_decline_effect: "見送り",
            on_decline_policy: "revise",
            factors: [],
          },
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "採用グループ案B",
            summary: "案Bを採用",
            on_accept_effect: "案B確定・案Aを自動クローズ",
            on_decline_effect: "見送り",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
    );
    const accGroupCards: unknown = pGrpAccept["cards"];
    expect(Array.isArray(accGroupCards) && accGroupCards.length === 2).toBe(true);
    const accWinnerId =
      Array.isArray(accGroupCards) && accGroupCards[0] !== undefined
        ? String(parseJsonObject(accGroupCards[0])["card_id"])
        : "";
    const accSiblingId =
      Array.isArray(accGroupCards) && accGroupCards[1] !== undefined
        ? String(parseJsonObject(accGroupCards[1])["card_id"])
        : "";

    const grpAcceptRes = await request.post(
      `${resolvedBase}/api/human/cards/${accWinnerId}/decide`,
      {
        headers: { Cookie: cookieHeader, Origin: resolvedBase },
        data: {
          request_id: "s2-grp-accept-winner",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      },
    );
    expect(grpAcceptRes.status()).toBe(200);
    await flushQueues(request, resolvedBase, 6_000);

    const closedSiblingDetail = await request.get(
      `${resolvedBase}/api/human/cards/${accSiblingId}`,
      {
        headers: { Cookie: cookieHeader },
      },
    );
    expect(closedSiblingDetail.status()).toBe(200);
    expect(parseJsonObject(await closedSiblingDetail.json())["status"]).toBe("closed");
    const cardsAfterGroupClose = await request.get(`${resolvedBase}/api/human/cards`, {
      headers: { Cookie: cookieHeader },
    });
    expect(cardsAfterGroupClose.status()).toBe(200);
    const pendingAfterClose: unknown = parseJsonObject(await cardsAfterGroupClose.json())[
      "pendingCards"
    ];
    expect(Array.isArray(pendingAfterClose)).toBe(true);
    if (Array.isArray(pendingAfterClose)) {
      expect(pendingAfterClose.some((c) => parseJsonObject(c)["id"] === accSiblingId)).toBe(false);
    }

    // -------------------------------------------------------------------------
    // 3) DEC-02 (M3) + BOT-02 CSRF: Real HTTP /decide idempotency replay, 409 IDEMPOTENCY_CONFLICT,
    //    CSRF 403, and 2-terminal concurrent /decide race -> exactly 1 finalized decision!
    // -------------------------------------------------------------------------
    const tDec02 = await callMcpTool(request, resolvedBase, workerToken, 25, "create_task", {
      request_id: "s2-create-dec02",
      title: "DEC-02 二重送信・2端末競合検証",
      description: "decide での request_id 冪等性と2端末同時送信排他を検証",
      requires_approval: true,
    });
    const dec02TaskId = String(tDec02["task_id"]);
    const cDec02 = await callMcpTool(request, resolvedBase, workerToken, 26, "claim_task", {
      request_id: "s2-claim-dec02",
      task_id: dec02TaskId,
      expected_version: Number(tDec02["version"]),
      lease_duration_seconds: 120,
    });
    const pDec02 = await callMcpTool(request, resolvedBase, workerToken, 27, "submit_proposal", {
      request_id: "s2-prop-dec02",
      task_id: dec02TaskId,
      expected_version: Number(cDec02["version"]),
      lease_token: String(cDec02["lease_token"]),
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "DEC-02 冪等性テスト案",
          summary: "同一 request_id 再送と不一致拒否",
          on_accept_effect: "採用確定",
          on_decline_effect: "見送り",
          on_decline_policy: "revise",
          factors: [],
        },
      ],
    });
    const dec02Cards: unknown = pDec02["cards"];
    const dec02CardId =
      Array.isArray(dec02Cards) && dec02Cards[0] !== undefined
        ? String(parseJsonObject(dec02Cards[0])["card_id"])
        : "";

    // BOT-02: CSRF check rejects state-changing POST without trusted Origin header
    const csrfRejected = await request.post(
      `${resolvedBase}/api/human/cards/${dec02CardId}/decide`,
      {
        headers: { Cookie: cookieHeader },
        data: {
          request_id: "fs-csrf-missing-origin",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      },
    );
    expect(csrfRejected.status()).toBe(403);

    // DEC-02: /decide replay returns identical response; mismatched payload returns 409 IDEMPOTENCY_CONFLICT
    const decideReq1 = await request.post(`${resolvedBase}/api/human/cards/${dec02CardId}/decide`, {
      headers: { Cookie: cookieHeader, Origin: resolvedBase },
      data: {
        request_id: "fs-idemp-decide-1",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(decideReq1.status()).toBe(200);
    const decideBody1 = parseJsonObject(await decideReq1.json());

    const decideReplay = await request.post(
      `${resolvedBase}/api/human/cards/${dec02CardId}/decide`,
      {
        headers: { Cookie: cookieHeader, Origin: resolvedBase },
        data: {
          request_id: "fs-idemp-decide-1",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      },
    );
    expect(decideReplay.status()).toBe(200);
    expect(await decideReplay.json()).toEqual(decideBody1);

    const decideConflict = await request.post(
      `${resolvedBase}/api/human/cards/${dec02CardId}/decide`,
      {
        headers: { Cookie: cookieHeader, Origin: resolvedBase },
        data: {
          request_id: "fs-idemp-decide-1",
          expected_version: 1,
          payload: { mode: "binary", decision: "declined" },
        },
      },
    );
    expect(decideConflict.status()).toBe(409);
    expect(parseJsonObject(await decideConflict.json())["code"]).toBe("IDEMPOTENCY_CONFLICT");

    // DEC-02: 2-terminal simultaneous /decide race with distinct request_ids on a fresh card -> [200, 409 VERSION_CONFLICT] & exactly 1 finalized decision!
    const tRace = await callMcpTool(request, resolvedBase, workerToken, 28, "create_task", {
      request_id: "s2-create-race",
      title: "DEC-02 2端末同時決定競合タスク",
      description: "2端末から同時に decide しても1件のみ確定",
      requires_approval: true,
    });
    const raceTaskId = String(tRace["task_id"]);
    const cRace = await callMcpTool(request, resolvedBase, workerToken, 29, "claim_task", {
      request_id: "s2-claim-race",
      task_id: raceTaskId,
      expected_version: Number(tRace["version"]),
      lease_duration_seconds: 120,
    });
    const pRace = await callMcpTool(request, resolvedBase, workerToken, 30, "submit_proposal", {
      request_id: "s2-prop-race",
      task_id: raceTaskId,
      expected_version: Number(cRace["version"]),
      lease_token: String(cRace["lease_token"]),
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "2端末同時送信カード",
          summary: "片方のみ成功・片方は VERSION_CONFLICT",
          on_accept_effect: "採用確定",
          on_decline_effect: "見送り",
          on_decline_policy: "revise",
          factors: [],
        },
      ],
    });
    const raceCards: unknown = pRace["cards"];
    const raceCardId =
      Array.isArray(raceCards) && raceCards[0] !== undefined
        ? String(parseJsonObject(raceCards[0])["card_id"])
        : "";

    const [raceA, raceB] = await Promise.all([
      request.post(`${resolvedBase}/api/human/cards/${raceCardId}/decide`, {
        headers: { Cookie: cookieHeader, Origin: resolvedBase },
        data: {
          request_id: "fs-2device-decide-A",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      }),
      request.post(`${resolvedBase}/api/human/cards/${raceCardId}/decide`, {
        headers: { Cookie: cookieHeader, Origin: resolvedBase },
        data: {
          request_id: "fs-2device-decide-B",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      }),
    ]);
    const raceStatuses = [raceA.status(), raceB.status()].sort((a, b) => a - b);
    expect(raceStatuses).toEqual([200, 409]);
    const loserRes = raceA.status() === 409 ? raceA : raceB;
    expect(parseJsonObject(await loserRes.json())["code"]).toBe("VERSION_CONFLICT");

    await flushQueues(request, resolvedBase, 6_000);
    const raceDecisions = await callMcpTool(
      request,
      resolvedBase,
      workerToken,
      31,
      "list_decision_results",
      { task_id: raceTaskId },
    );
    const raceItems: unknown = raceDecisions["items"];
    expect(Array.isArray(raceItems) ? raceItems.length : -1).toBe(1);

    // -------------------------------------------------------------------------
    // 4) UX-03 + UX-05 + Multi-select + Cron Duty #1 & #4 recovery
    // -------------------------------------------------------------------------
    const tMulti = await callMcpTool(request, resolvedBase, workerToken, 35, "create_task", {
      request_id: "s2-create-multi",
      title: "複数チェック＆Cron回収検証",
      description: "multi選択とCron自動確定・配送の縦通し確認",
      requires_approval: true,
    });
    const multiTaskId = String(tMulti["task_id"]);
    const cMulti = await callMcpTool(request, resolvedBase, workerToken, 36, "claim_task", {
      request_id: "s2-claim-multi",
      task_id: multiTaskId,
      expected_version: Number(tMulti["version"]),
      lease_duration_seconds: 120,
    });
    const pMulti = await callMcpTool(request, resolvedBase, workerToken, 37, "submit_proposal", {
      request_id: "s2-prop-multi",
      task_id: multiTaskId,
      expected_version: Number(cMulti["version"]),
      lease_token: String(cMulti["lease_token"]),
      proposals: [
        {
          card_type: "policy",
          selection_mode: "multi",
          options: [
            {
              id: "m-sp",
              title: "SP片手UIを優先",
              summary: "幅360px/320pxでの誤スワイプ防止を先行",
              meta: "工数小",
              recommended: true,
            },
            {
              id: "m-pc",
              title: "PCキーボード対応を含める",
              summary: "矢印キー・数字キーによる高速判断を提供",
              meta: "工数小",
              recommended: true,
            },
            {
              id: "m-native",
              title: "ネイティブアプリ化（後続）",
              summary: "MVP後続フェーズで検討",
              meta: "工数大",
            },
          ],
          title: "初版に含めるチェック項目を選択してください",
          summary: "複数チェックの選択確定と Cron 確定回収を確認します。",
          on_accept_effect: "チェック済み項目を採用して次ステップへ",
          on_decline_effect: "全部見送り",
          on_decline_policy: "revise",
          factors: [],
        },
      ],
    });
    const multiCards: unknown = pMulti["cards"];
    const multiCardId =
      Array.isArray(multiCards) && multiCards[0] !== undefined
        ? String(parseJsonObject(multiCards[0])["card_id"])
        : "";

    // Open / -> jump to multi card cleanly (or defer top card via ArrowDown on PC / btn-defer on SP to test defer!)
    await page.goto("/");
    await expect(page.getByTestId("top-decision-card")).toBeVisible();
    // Exercise ArrowDown (PC) / btn-defer (SP) on the current top card (Minor 5: confirm top card visible first)
    if (testInfo.project.name === "pc-desktop") {
      await page.keyboard.press("ArrowDown");
    } else {
      await page.getByTestId("btn-defer").click();
    }
    // Select multi card via queue chip if other deliverable cards are ahead of it
    const multiChip = page.getByTestId(`queue-chip-${multiCardId}`);
    if (await multiChip.isVisible()) {
      await multiChip.click();
    }
    await expect(page.getByTestId("card-headline")).toContainText(
      "初版に含めるチェック項目を選択してください",
    );
    // UX-03: Before-action outcomes visible on multi-select card
    await expect(page.getByTestId("outcome-accept")).toContainText(
      "チェック済み項目を採用して次ステップへ",
    );
    await expect(page.getByTestId("outcome-decline")).toContainText("全部見送り");

    // Recommended items (m-sp, m-pc) start checked -> uncheck m-pc, check m-native (keyboard 2, 3 on PC; click on SP)
    if (testInfo.project.name === "pc-desktop") {
      await page.keyboard.press("2");
      await page.keyboard.press("3");
    } else {
      await page.getByTestId("option-checkbox-m-pc").click();
      await page.getByTestId("option-checkbox-m-native").click();
    }
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("undo-banner")).toBeVisible();

    const cronRes = await request.post(`${resolvedBase}/__fullstack/run-cron`, {
      data: { advanceMs: 6_000 },
    });
    expect(cronRes.status()).toBe(200);
    const cronReport = parseJsonObject(await cronRes.json());
    expect(Number(cronReport["finalizedCount"])).toBeGreaterThanOrEqual(1);
    expect(Number(cronReport["redispatchedDecisionsCount"])).toBeGreaterThanOrEqual(1);

    const multiDecisions = await callMcpTool(
      request,
      resolvedBase,
      workerToken,
      38,
      "list_decision_results",
      { task_id: multiTaskId },
    );
    const multiItems: unknown = multiDecisions["items"];
    expect(Array.isArray(multiItems) && multiItems.length === 1).toBe(true);
    if (Array.isArray(multiItems) && multiItems[0] !== undefined) {
      const dec = parseJsonObject(multiItems[0]);
      expect(dec["result"]).toBe("accepted");
      expect(dec["selected_option_ids"]).toEqual(["m-sp", "m-native"]);
    }
    const flushAfterCron = await flushQueues(request, resolvedBase, 6_000);
    expect(flushAfterCron.botWorkProcessed).toBeGreaterThanOrEqual(1);

    // -------------------------------------------------------------------------
    // 5) BOT-03 (DLQ + Retry) + BOT-02 (WORKSPACE_PAUSED, Live Scope Narrowing, 2-step Revocation)
    // -------------------------------------------------------------------------
    const tDlq = await callMcpTool(request, resolvedBase, workerToken, 40, "create_task", {
      request_id: "s2-create-dlq",
      title: "DLQ 失敗可視化タスク",
      description: "再試行上限超過時の失敗表示検証",
      requires_approval: true,
    });
    const dlqTaskId = String(tDlq["task_id"]);
    const cDlq = await callMcpTool(request, resolvedBase, workerToken, 41, "claim_task", {
      request_id: "s2-claim-dlq",
      task_id: dlqTaskId,
      expected_version: Number(tDlq["version"]),
      lease_duration_seconds: 120,
    });
    const pDlq = await callMcpTool(request, resolvedBase, workerToken, 42, "submit_proposal", {
      request_id: "s2-prop-dlq",
      task_id: dlqTaskId,
      expected_version: Number(cDlq["version"]),
      lease_token: String(cDlq["lease_token"]),
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "DLQ検証タスクを実行開始する？",
          summary: "承認後に DLQ 退避を再現",
          on_accept_effect: "実行開始",
          on_decline_effect: "見送り",
          on_decline_policy: "revise",
          factors: [],
        },
      ],
    });
    const dlqCards: unknown = pDlq["cards"];
    const dlqCardId =
      Array.isArray(dlqCards) && dlqCards[0] !== undefined
        ? String(parseJsonObject(dlqCards[0])["card_id"])
        : "";

    const dlqDecideRes = await request.post(`${resolvedBase}/api/human/cards/${dlqCardId}/decide`, {
      headers: { Cookie: cookieHeader, Origin: resolvedBase },
      data: {
        request_id: "s2-dlq-decide",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(dlqDecideRes.status()).toBe(200);

    // Pause workspace so finalized task stays in `ready`, verify BOT-02 WORKSPACE_PAUSED rejection on /api/mcp, then push DLQ!
    const wsRes = await request.get(`${resolvedBase}/api/human/workspace`, {
      headers: { Cookie: cookieHeader },
    });
    expect(wsRes.ok()).toBe(true);
    const wsVersion = Number(parseJsonObject(await wsRes.json())["version"]);
    const pauseRes = await request.patch(`${resolvedBase}/api/human/workspace`, {
      headers: { Cookie: cookieHeader, Origin: resolvedBase },
      data: { request_id: "s2-pause-for-dlq", expected_version: wsVersion, is_paused: true },
    });
    expect(pauseRes.ok()).toBe(true);
    const pausedWsVersion = Number(parseJsonObject(await pauseRes.json())["version"]);

    // BOT-02: Workspace pause IMMEDIATELY rejects Bot writes over /api/mcp with WORKSPACE_PAUSED
    const pausedWriteErr = await callMcpToolExpectError(
      request,
      resolvedBase,
      workerToken,
      43,
      "create_task",
      {
        request_id: "s2-paused-write-attempt",
        title: "一時停止中は作成不可",
        description: "WORKSPACE_PAUSED 検証",
      },
    );
    expect(pausedWriteErr).toContain("WORKSPACE_PAUSED");

    await flushQueues(request, resolvedBase, 6_000);
    const pushDlqRes = await request.post(`${resolvedBase}/__fullstack/push-dlq`, {
      data: { task_id: dlqTaskId },
    });
    expect(pushDlqRes.ok()).toBe(true);

    // Unpause workspace cleanly (Minor 6)
    const unpauseRes = await request.patch(`${resolvedBase}/api/human/workspace`, {
      headers: { Cookie: cookieHeader, Origin: resolvedBase },
      data: {
        request_id: "s2-unpause-after-dlq",
        expected_version: pausedWsVersion,
        is_paused: false,
      },
    });
    expect(unpauseRes.ok()).toBe(true);

    // BOT-03: /board shows task in failed column (NEVER done!) with reason and retry count
    await page.goto("/board");
    await expect(
      page.getByTestId("kanban-col-failed").getByTestId(`board-task-${dlqTaskId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId("kanban-col-done").getByTestId(`board-task-${dlqTaskId}`),
    ).toHaveCount(0);
    await expect(page.getByTestId(`board-task-reason-${dlqTaskId}`)).toContainText("bot-work-dlq");
    await expect(page.getByTestId(`board-task-retry-count-${dlqTaskId}`)).toContainText(
      "再試行回数: 1回",
    );

    // /history separates 採用確定 vs 実行失敗 (BOT-03)
    await page.goto("/history");
    await page.getByTestId("history-filter-failed").click();
    await expect(page.getByTestId("history-list")).toContainText("採用確定");
    await expect(page.getByTestId("history-list")).toContainText("実行失敗 (BOT-03)");

    // Owner clicks Retry on /board -> failed transitions cleanly to ready!
    await page.goto("/board");
    await page.getByTestId(`btn-retry-task-${dlqTaskId}`).click();
    await expect(
      page.getByTestId("kanban-col-ready").getByTestId(`board-task-${dlqTaskId}`),
    ).toBeVisible();

    // BOT-02: Live scope narrowing in /settings IMMEDIATELY rejects Bot writes with NOT_AUTHORIZED,
    //         followed by 2-step irreversible revocation immediately rejecting all /api/mcp calls with 401!
    await page.goto("/settings");
    const botsListRes = await request.get(`${resolvedBase}/api/human/bots`, {
      headers: { Cookie: cookieHeader },
    });
    expect(botsListRes.ok()).toBe(true);
    const botsItems: unknown = parseJsonObject(await botsListRes.json())["items"];
    const workerBotId =
      Array.isArray(botsItems) && botsItems[0] !== undefined
        ? String(parseJsonObject(botsItems[0])["id"])
        : "";
    expect(workerBotId).not.toBe("");

    await page.getByTestId(`bot-scope-${workerBotId}-tasks:write`).click();
    await expect(page.getByTestId(`bot-scope-${workerBotId}-tasks:write`)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const narrowedWriteErr = await callMcpToolExpectError(
      request,
      resolvedBase,
      workerToken,
      44,
      "create_task",
      {
        request_id: "s2-narrowed-write-attempt",
        title: "スコープ縮小後は作成不可",
        description: "NOT_AUTHORIZED 検証",
      },
    );
    expect(narrowedWriteErr).toContain("NOT_AUTHORIZED");

    await page.getByTestId(`btn-request-revoke-${workerBotId}`).click();
    await expect(page.getByTestId(`revoke-confirm-box-${workerBotId}`)).toBeVisible();
    await page.getByTestId(`btn-confirm-revoke-${workerBotId}`).click();
    await expect(page.getByTestId(`settings-bot-status-${workerBotId}`)).toHaveText("revoked");

    const revokedMcp = await callMcpRaw(request, resolvedBase, workerToken, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "list_tasks", arguments: {} },
    });
    expect(revokedMcp.status).toBe(401);
  });
});
