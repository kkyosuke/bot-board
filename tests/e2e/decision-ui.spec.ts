import { expect, type Page, test } from "@playwright/test";

async function assertAllVisibleButtonsMeetTouchTarget(page: Page): Promise<void> {
  const buttons = page.locator("button:visible");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);

  let checkedInteractiveCount = 0;
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const isInteractive = await button.evaluate(
      (el) => el.closest('[aria-hidden="true"], [inert]') === null,
    );
    if (!isInteractive) {
      continue;
    }
    checkedInteractiveCount += 1;
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      const label =
        (await button.getAttribute("data-testid")) ??
        (await button.getAttribute("aria-label")) ??
        (await button.innerText());
      expect(box.height, `button "${label}" height >= 44px`).toBeGreaterThanOrEqual(44);
      expect(box.width, `button "${label}" width >= 44px`).toBeGreaterThanOrEqual(44);
    }
  }
  expect(checkedInteractiveCount).toBeGreaterThan(0);
}

test.describe("S5 Main Decision Card UI (UX-01〜05, DEC-01, DEC-04)", () => {
  test("renders readable task cards, before-action outcomes across all 3 selection modes (UX-03), >=44px targets for all visible buttons, and zero horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/?mode=mock");

    const topCard = page.getByTestId("top-decision-card");
    await expect(topCard).toBeVisible();
    await expect(page.getByTestId("card-headline")).toContainText(
      "初版はスマホの判断カード体験だけに絞る？",
    );
    await expect(page.getByTestId("outcome-accept")).toBeVisible();
    await expect(page.getByTestId("outcome-decline")).toBeVisible();

    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(overflow).toBe(false);

    // Every visible button on screen must meet >= 44x44 CSS px (UX-05)
    await assertAllVisibleButtonsMeetTouchTarget(page);

    // Verify UX-03 before-action outcome preview on single-choice card
    await page.getByTestId("queue-chip-card-single-auth").click();
    await expect(page.getByTestId("card-headline")).toContainText(
      "オーナー認証はどの方式を採用する？",
    );
    await expect(page.getByTestId("outcome-accept")).toBeVisible();
    await expect(page.getByTestId("outcome-decline")).toBeVisible();

    // Verify UX-03 before-action outcome preview on multi-select card
    await page.getByTestId("queue-chip-card-multi-ux").click();
    await expect(page.getByTestId("card-headline")).toContainText("どの項目を今回の実装に含める？");
    await expect(page.getByTestId("outcome-accept")).toBeVisible();
    await expect(page.getByTestId("outcome-decline")).toBeVisible();
    await assertAllVisibleButtonsMeetTouchTarget(page);
  });

  test("prevents accidental submission on vertical scroll drag, sub-threshold drag, SP screen edge drag, and outside-card mouse release (UX-04)", async ({
    page,
    viewport,
  }) => {
    await page.goto("/?mode=mock");

    const topCard = page.getByTestId("top-decision-card");
    await expect(topCard).toBeVisible();
    const box = await topCard.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) {
      return;
    }

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height * 0.35;

    // Vertical scroll drag should not commit
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 12, startY - 90, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");

    // Sub-threshold horizontal drag (45px) should spring back without submitting
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 45, startY + 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
    await expect(page.getByTestId("undo-banner")).toHaveCount(0);

    // On SP viewports (<768px), starting drag within 24px of screen edge must yield to OS back gesture
    if (viewport !== null && viewport.width < 768) {
      const edgeX = Math.max(box.x + 2, 16);
      await page.mouse.move(edgeX, startY);
      await page.mouse.down();
      await page.mouse.move(edgeX + 150, startY, { steps: 10 });
      await page.mouse.up();
      await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
      await expect(page.getByTestId("undo-banner")).toHaveCount(0);
    }

    // On PC viewports, pressing mouse down near top border, releasing outside card, and moving back with mouse UP must not stick or swipe
    if (viewport !== null && viewport.width >= 1024) {
      const nearTopX = box.x + box.width * 0.4;
      const nearTopY = box.y + 4;
      await page.mouse.move(nearTopX, nearTopY);
      await page.mouse.down();
      await page.mouse.move(nearTopX, Math.max(1, box.y - 30), { steps: 2 });
      await page.mouse.up();

      // Move back over the card horizontally WITHOUT pressing mouse button
      await page.mouse.move(box.x + box.width * 0.25, startY, { steps: 2 });
      await page.mouse.move(box.x + box.width * 0.85, startY, { steps: 8 });
      await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
      await expect(page.getByTestId("undo-banner")).toHaveCount(0);
    }
  });

  test("supports right/left swipe, 5s undo with selection restoration (DEC-01), single/multi rules (DEC-04), defer/restore, and modal Escape", async ({
    page,
  }) => {
    await page.goto("/?mode=mock");

    const topCard = page.getByTestId("top-decision-card");
    await expect(topCard).toBeVisible();
    const box = await topCard.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) {
      return;
    }

    const startX = box.x + box.width * 0.5;
    const startY = box.y + box.height * 0.3;

    // 1. Right swipe commits binary card and opens 5s undo banner
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 140, startY, { steps: 10 });
    await page.mouse.up();

    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 5");
    await expect(page.getByTestId("undo-banner")).toBeVisible();

    // 2. Clicking undo within 5s restores card back to top (DEC-01)
    await page.getByTestId("btn-undo").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
    await expect(page.getByTestId("card-headline")).toContainText(
      "初版はスマホの判断カード体験だけに絞る？",
    );

    // 3. Left swipe declines binary card and advances to Single 3-Choice card
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 140, startY, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("card-headline")).toContainText(
      "オーナー認証はどの方式を採用する？",
    );

    // 4. Select Passkey radio option, accept, undo, and verify Passkey selection is restored
    await page.getByTestId("option-radio-passkey").click();
    await expect(page.getByTestId("option-radio-passkey")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 4");
    await page.getByTestId("btn-undo").click();
    await expect(page.getByTestId("card-headline")).toContainText(
      "オーナー認証はどの方式を採用する？",
    );
    await expect(page.getByTestId("option-radio-passkey")).toHaveAttribute("aria-checked", "true");

    // Decline all candidates on single-choice card (DEC-04)
    await page.getByTestId("btn-decline").click();
    await expect(page.getByTestId("card-headline")).toContainText("どの項目を今回の実装に含める？");

    // 5. Multi-select checkbox card: 0 checked blocks button, right-swipe, and ArrowRight
    await page.getByTestId("btn-toggle-all").click();
    await page.getByTestId("btn-toggle-all").click();
    await expect(page.getByTestId("btn-accept")).toBeDisabled();

    // Right swipe with 0 checked must NOT commit
    const multiBox = await page.getByTestId("top-decision-card").boundingBox();
    expect(multiBox).not.toBeNull();
    if (multiBox !== null) {
      const mx = multiBox.x + multiBox.width * 0.45;
      const my = multiBox.y + 42;
      await page.mouse.move(mx, my);
      await page.mouse.down();
      await page.mouse.move(mx + 140, my, { steps: 10 });
      await page.mouse.up();
    }
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 4");

    // ArrowRight with 0 checked must NOT commit
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 4");

    // Check 1 item, accept, undo, and confirm exact 1-item selection state is restored
    await page.getByTestId("option-checkbox-undo-5s").click();
    await expect(page.getByTestId("btn-accept")).toBeEnabled();
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 3");
    await page.getByTestId("btn-undo").click();
    await expect(page.getByTestId("card-headline")).toContainText("どの項目を今回の実装に含める？");
    await expect(page.getByTestId("option-checkbox-undo-5s")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("option-checkbox-slash-feedback")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Decline entire multi-select card via action button (activates 5s UndoBanner 100ms ticks)
    await page.getByTestId("btn-decline").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 3");
    await expect(page.getByTestId("undo-banner")).toBeVisible();

    // 6. Detail modal opens, focuses close button, and closes on Escape restoring trigger focus
    const detailBtn = page.getByTestId("btn-open-detail");
    await detailBtn.click();
    await expect(page.getByTestId("detail-sheet")).toBeVisible();
    await expect(page.getByTestId("btn-close-sheet")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("detail-sheet")).toHaveCount(0);
    await expect(detailBtn).toBeFocused();

    // 7. Defer and open deferred sheet while UndoBanner ticks; focus inside modal must NOT be stolen back to close button
    await page.getByTestId("btn-defer").click();
    await expect(page.getByTestId("deferred-count")).toHaveText("1");
    await expect(page.getByTestId("undo-banner")).toBeVisible();
    await page.getByTestId("btn-open-deferred").click();
    await expect(page.getByTestId("deferred-sheet")).toBeVisible();

    const restoreBtn = page.getByTestId("btn-restore-card-binary-deliverable");
    await restoreBtn.focus();
    await expect(restoreBtn).toBeFocused();
    await page.waitForTimeout(350);
    await expect(restoreBtn).toBeFocused();

    await restoreBtn.click();
    await expect(page.getByTestId("deferred-count")).toHaveText("0");
    await expect(page.getByTestId("card-headline")).toContainText(
      "競合5アプリの誤スワイプ対策レポート",
    );
  });

  test("protects modifier shortcuts, verifies StrictMode single finalization, renders all 6 UI states with offline defer safety, and honors prefers-reduced-motion", async ({
    page,
    viewport,
  }) => {
    if (viewport !== null && viewport.width >= 1024) {
      await page.goto("/?mode=mock");
      await expect(page.getByTestId("pc-inspector")).toBeVisible();
      await expect(page.getByTestId("top-decision-card")).toBeVisible();

      // Modifier shortcuts must NEVER trigger card actions
      await page.keyboard.press("Alt+ArrowLeft");
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Control+d");
      await page.keyboard.press("Control+s");
      await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
      await expect(page.getByTestId("undo-banner")).toHaveCount(0);

      // ArrowRight accepts binary card; z undoes it
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("remaining-badge")).toHaveText("残り 5");
      await page.keyboard.press("z");
      await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");

      // ArrowLeft declines binary card; press 2 to select Passkey; ArrowRight confirms
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByTestId("card-headline")).toContainText(
        "オーナー認証はどの方式を採用する？",
      );
      await page.keyboard.press("2");
      await expect(page.getByTestId("option-radio-passkey")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("remaining-badge")).toHaveText("残り 4");

      // Wait for 5s provisional window to finalize and confirm StrictMode emits exactly 1 finalized log per card
      await page.getByTestId("tab-log").click();
      await expect(page.getByTestId("undo-banner")).toHaveCount(0, { timeout: 7_000 });
      const finalizedEntries = page
        .getByTestId("pc-inspector")
        .getByText("確定完了→Bot送信: オーナー認証はどの方式を採用する？");
      await expect(finalizedEntries).toHaveCount(1);
    }

    // Verify loading, empty, bot_running, bot_disconnected, and offline_error states
    await page.goto("/?mode=mock&state=loading");
    await expect(page.getByTestId("state-card-loading")).toBeVisible();

    await page.goto("/?mode=mock&state=empty");
    await expect(page.getByTestId("state-card-empty")).toBeVisible();

    await page.goto("/?mode=mock&state=bot_running");
    await expect(page.getByTestId("state-card-bot-running")).toBeVisible();

    await page.goto("/?mode=mock&state=bot_disconnected");
    await expect(page.getByTestId("state-card-bot-disconnected")).toBeVisible();

    await page.goto("/?mode=mock&state=offline_error");
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByTestId("top-decision-card")).toBeVisible();
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
    await page.getByTestId("btn-defer").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 6");
    await expect(page.getByTestId("deferred-count")).toHaveText("0");
    await page.getByTestId("btn-recover-online").click();
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
    await expect(page.getByTestId("cleared-counter")).toHaveText("消費 0/6件");

    // Verify prefers-reduced-motion works smoothly without slash beam overlay
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("btn-accept").click();
    await expect(page.getByTestId("remaining-badge")).toHaveText("残り 5");
  });
});
