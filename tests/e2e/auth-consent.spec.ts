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
    const box = await buttons.nth(i).boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
}

test.describe("S4 Owner Sign-In (/sign-in) & OAuth 2.1 Consent (/consent) UI (BOT-02)", () => {
  test("renders /sign-in normal, 403 non-owner, and already-signed-in approved states with >=44px targets and zero overflow", async ({
    page,
  }) => {
    // 1. Unauthenticated -> normal GitHub OAuth sign-in screen
    await page.route("**/api/human/workspace", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "NOT_AUTHORIZED", message: "Sign-in required" }),
      });
    });

    await page.goto("/sign-in?next=%2Fconsent%3Fclient_id%3Dc1%26sig%3Ds1");
    await expect(page.getByTestId("github-sign-in-btn")).toBeVisible();
    await expect(page.getByText("OWNER_GITHUB_ID")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // 1b. OAuth cancel/error query param -> explicit error alert banner
    await page.goto("/sign-in?error=access_denied");
    await expect(page.getByTestId("sign-in-error-alert")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // 2. Non-owner 403 -> explicit 403 alert banner
    await page.unroute("**/api/human/workspace");
    await page.route("**/api/human/workspace", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          code: "NOT_AUTHORIZED",
          message: "Only configured single owner GitHub account is allowed.",
        }),
      });
    });

    await page.goto("/sign-in?next=%2Fconsent%3Fclient_id%3Dc1%26sig%3Ds1");
    await expect(page.getByTestId("sign-in-non-owner-alert")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // 3. Authenticated owner -> approved screen with safe next CTA
    await page.unroute("**/api/human/workspace");
    await page.route("**/api/human/workspace", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "ws_1", is_paused: false, version: 1 }),
      });
    });

    await page.reload();
    await expect(page.getByTestId("sign-in-approved")).toBeVisible();
    await expect(page.getByTestId("sign-in-continue-btn")).toContainText("/consent へ進む");
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);
  });

  test("redirects unauthenticated /consent to /sign-in?next=... and disables Approve on 403, revoked, and error states (BOT-02)", async ({
    page,
  }) => {
    // 1. 401 on /consent redirects to /sign-in?next=...
    await page.route("**/api/human/oauth/consent-context*", async (route) => {
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

    await page.goto("/consent?client_id=client_chatgpt&scope=openid+tasks:read&sig=valid_sig");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fconsent/);
    await expect(page.getByTestId("github-sign-in-btn")).toBeVisible();

    // 2. 403 non-owner on /consent -> Approve MUST be disabled
    await page.unroute("**/api/human/oauth/consent-context*");
    await page.route("**/api/human/oauth/consent-context*", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "NOT_AUTHORIZED", message: "Non-owner forbidden" }),
      });
    });

    await page.goto("/consent?client_id=client_chatgpt&scope=openid+tasks:read&sig=valid_sig");
    await expect(page.getByTestId("consent-non-owner")).toBeVisible();
    await expect(page.getByTestId("consent-approve-btn")).toBeDisabled();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // 3. Revoked client -> scope checkboxes, Deny, and Approve MUST ALL be disabled
    await page.unroute("**/api/human/oauth/consent-context*");
    await page.route("**/api/human/oauth/consent-context*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          client_id: "client_revoked_1",
          client_name: "Revoked MCP Client",
          client_uri: "https://chatgpt.com",
          redirect_uris: ["https://chatgpt.com/cb"],
          requested_bot_scopes: ["tasks:read", "tasks:write"],
          other_requested_scopes: ["openid"],
          existing_bot_id: "bot_revoked_1",
          existing_status: "revoked",
          existing_scopes: ["tasks:read"],
        }),
      });
    });

    await page.goto(
      "/consent?client_id=client_revoked_1&scope=openid+tasks:read+tasks:write&sig=s1",
    );
    await expect(page.getByTestId("consent-revoked-alert")).toBeVisible();
    await expect(page.getByTestId("consent-approve-btn")).toBeDisabled();
    await expect(page.getByTestId("consent-deny-btn")).toBeDisabled();
    await expect(page.getByTestId("consent-scope-tasks:read")).toBeDisabled();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // 4. Error state (missing sig) -> Approve & Deny MUST be disabled + >=44px targets
    await page.goto("/consent?client_id=client_missing_sig");
    await expect(page.getByTestId("consent-error-alert")).toBeVisible();
    await expect(page.getByTestId("consent-approve-btn")).toBeDisabled();
    await expect(page.getByTestId("consent-deny-btn")).toBeDisabled();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);
  });

  test("supports scope narrowing, 0-scope guard, Approve (D1 upsert summary), and Deny (access_denied) on /consent", async ({
    page,
  }) => {
    const consentPayloads: Record<string, unknown>[] = [];

    await page.route("**/api/human/oauth/consent-context*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          client_id: "client_chatgpt_live",
          client_name: "ChatGPT Remote MCP",
          client_uri: "https://chatgpt.com",
          redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
          requested_bot_scopes: ["tasks:read", "tasks:write", "proposals:write", "decisions:read"],
          other_requested_scopes: ["openid"],
          existing_bot_id: null,
          existing_status: null,
          existing_scopes: [],
        }),
      });
    });

    await page.route("**/api/auth/oauth2/consent", async (route) => {
      const rawBody: unknown = route.request().postDataJSON();
      const parsed =
        rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody)
          ? Object.fromEntries(Object.entries(rawBody))
          : {};
      consentPayloads.push(parsed);

      const accepted = parsed["accept"] === true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          redirect: true,
          url: accepted
            ? "https://chatgpt.com/connector_platform_oauth_redirect?code=code_123&state=st1"
            : "https://chatgpt.com/connector_platform_oauth_redirect?error=access_denied&state=st1",
        }),
      });
    });

    const query =
      "client_id=client_chatgpt_live&scope=openid+tasks:read+tasks:write+proposals:write+decisions:read&sig=valid_sig";
    await page.goto(`/consent?${query}`);

    await expect(page.getByTestId("consent-bot02-prohibition")).toBeVisible();
    await expect(page.getByTestId("consent-approve-btn")).toContainText("4スコープで許可");
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // Narrow out proposals:write & decisions:read
    await page.getByTestId("consent-scope-proposals:write").click();
    await page.getByTestId("consent-scope-decisions:read").click();
    await expect(page.getByTestId("consent-approve-btn")).toContainText("2スコープで許可");

    // Uncheck remaining 2 -> 0 scopes MUST disable Approve button
    await page.getByTestId("consent-scope-tasks:read").click();
    await page.getByTestId("consent-scope-tasks:write").click();
    await expect(page.getByTestId("consent-approve-btn")).toBeDisabled();

    // Deny works even when 0 scopes selected
    await page.getByTestId("consent-deny-btn").click();
    await expect(page.getByTestId("consent-denied-banner")).toBeVisible();
    expect(consentPayloads[0]?.["accept"]).toBe(false);

    // Re-check 2 scopes and Approve -> sends exact narrowed scope string and renders D1 summary
    await page.getByTestId("consent-scope-tasks:read").click();
    await page.getByTestId("consent-scope-tasks:write").click();
    await expect(page.getByTestId("consent-approve-btn")).toBeEnabled();
    await page.getByTestId("consent-approve-btn").click();

    await expect(page.getByTestId("consent-approved")).toBeVisible();
    expect(consentPayloads[1]?.["accept"]).toBe(true);
    expect(consentPayloads[1]?.["scope"]).toBe("openid tasks:read tasks:write");
    expect(consentPayloads[1]?.["oauth_query"]).toBe(query);
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);
  });

  test("handles prompt=login forced re-auth with oauth_query forwarding, Owner Sign-Out on /sign-in, and zero-scope warning on /consent (Sec-M3, Sec-M4, Sec-m5)", async ({
    page,
  }) => {
    const signInPayloads: Record<string, unknown>[] = [];
    let signOutCalls = 0;

    await page.route("**/api/human/workspace", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "ws_1", is_paused: false, version: 1 }),
      });
    });

    await page.route("**/api/auth/sign-in/social", async (route) => {
      const raw: unknown = route.request().postDataJSON();
      const parsed =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? Object.fromEntries(Object.entries(raw))
          : {};
      signInPayloads.push(parsed);
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ message: "Mock intercept after capturing oauth_query" }),
      });
    });

    await page.route("**/api/auth/sign-out", async (route) => {
      signOutCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    // 1. Authenticated owner visiting /sign-in with prompt=login MUST see re-auth notice + GitHub button (NOT approved loop)
    const reauthQuery =
      "client_id=client_mcp_1&prompt=login&ba_iat=1760000000000&ba_param=client_id&ba_param=prompt&ba_param=ba_iat&ba_param=ba_param&utm_source=noise&sig=sig_reauth";
    await page.goto(`/sign-in?${reauthQuery}`);
    await expect(page.getByTestId("sign-in-reauth-notice")).toBeVisible();
    await expect(page.getByTestId("sign-in-approved")).toHaveCount(0);
    await expect(page.getByTestId("github-sign-in-btn")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);

    // Clicking GitHub re-auth MUST forward filtered signed oauth_query (dropping utm_source)
    await page.getByTestId("github-sign-in-btn").click();
    await expect(page.getByTestId("sign-in-error-alert")).toBeVisible();
    expect(signInPayloads.length).toBe(1);
    const rawForwardedQuery = signInPayloads[0]?.["oauth_query"];
    const forwardedQuery = typeof rawForwardedQuery === "string" ? rawForwardedQuery : "";
    expect(forwardedQuery).toContain("client_id=client_mcp_1");
    expect(forwardedQuery).toContain("prompt=login");
    expect(forwardedQuery).toContain("sig=sig_reauth");
    expect(forwardedQuery).not.toContain("utm_source");

    // 2. Normal /sign-in when authenticated shows approved state with >=44px Sign-Out button
    await page.goto("/sign-in");
    await expect(page.getByTestId("sign-in-approved")).toBeVisible();
    await expect(page.getByTestId("sign-out-btn")).toBeVisible();
    await assertAllVisibleButtonsAtLeast44px(page);
    await page.getByTestId("sign-out-btn").click();
    await expect(page.getByTestId("github-sign-in-btn")).toBeVisible();
    expect(signOutCalls).toBe(1);

    // 3. Zero bot scopes on /consent renders explicit warning and disables Approve
    await page.route("**/api/human/oauth/consent-context*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          client_id: "client_oidc_only",
          client_name: "OIDC-Only Client",
          client_uri: "https://example.com",
          redirect_uris: ["https://example.com/cb"],
          requested_bot_scopes: [],
          other_requested_scopes: ["openid", "profile"],
          existing_bot_id: null,
          existing_status: null,
          existing_scopes: [],
        }),
      });
    });

    await page.goto("/consent?client_id=client_oidc_only&scope=openid+profile&sig=valid_sig");
    await expect(page.getByTestId("consent-zero-scope-warning")).toBeVisible();
    await expect(page.getByTestId("consent-approve-btn")).toBeDisabled();
    await expect(page.getByTestId("consent-deny-btn")).toBeEnabled();
    await assertNoHorizontalOverflow(page);
    await assertAllVisibleButtonsAtLeast44px(page);
  });
});
