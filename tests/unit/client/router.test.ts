import { describe, expect, test } from "bun:test";

import {
  buildSignInRedirectPath,
  isSafeRedirectUrl,
  normalizeSafeNextPath,
  parseAppRoute,
} from "@/client/router";

describe("shared client SPA router & redirect safety (S4, M1)", () => {
  test("parses all 6 MVP routes and normalizes trailing slashes", () => {
    expect(parseAppRoute("/")).toBe("/");
    expect(parseAppRoute("/board")).toBe("/board");
    expect(parseAppRoute("/board/")).toBe("/board");
    expect(parseAppRoute("/history")).toBe("/history");
    expect(parseAppRoute("/settings")).toBe("/settings");
    expect(parseAppRoute("/sign-in")).toBe("/sign-in");
    expect(parseAppRoute("/consent")).toBe("/consent");
    expect(parseAppRoute("/unknown-page")).toBe("/");
  });

  test("blocks open-redirect, dot-segment // collapse, backslash, and control-char payloads in normalizeSafeNextPath and buildSignInRedirectPath (M1)", () => {
    expect(normalizeSafeNextPath("/consent?client_id=c1&sig=abc")).toBe(
      "/consent?client_id=c1&sig=abc",
    );
    expect(normalizeSafeNextPath("/settings")).toBe("/settings");
    expect(normalizeSafeNextPath("https://evil.example/phish")).toBe("/");
    expect(normalizeSafeNextPath("//evil.example/phish")).toBe("/");
    expect(normalizeSafeNextPath("/.//evil.example/phish")).toBe("/");
    expect(normalizeSafeNextPath("/a/..//evil.example/phish")).toBe("/");
    expect(normalizeSafeNextPath("/%2e//evil.example/phish")).toBe("/");
    expect(normalizeSafeNextPath("/\\evil.example")).toBe("/");
    expect(normalizeSafeNextPath("/\t/evil.example")).toBe("/");
    expect(normalizeSafeNextPath("/\n/evil.example")).toBe("/");
    expect(normalizeSafeNextPath("/\r/evil.example")).toBe("/");
    expect(normalizeSafeNextPath("/\u0000/evil.example")).toBe("/");
    expect(normalizeSafeNextPath("javascript:alert(1)")).toBe("/");
    expect(normalizeSafeNextPath("")).toBe("/");
    expect(normalizeSafeNextPath(null)).toBe("/");

    expect(buildSignInRedirectPath("/consent?client_id=c1&sig=xyz")).toBe(
      "/sign-in?next=%2Fconsent%3Fclient_id%3Dc1%26sig%3Dxyz",
    );
    expect(buildSignInRedirectPath("/")).toBe("/sign-in");
    expect(buildSignInRedirectPath("/sign-in?next=/board")).toBe("/sign-in");
    expect(buildSignInRedirectPath("//evil.example")).toBe("/sign-in");
    expect(buildSignInRedirectPath("/.//evil.example")).toBe("/sign-in");
  });

  test("validates external OAuth redirect URLs and blocks javascript:/data:/backslash/control-char/dot-collapse bypasses (M1)", () => {
    expect(isSafeRedirectUrl("https://chatgpt.com/connector_platform_oauth_redirect?code=1")).toBe(
      true,
    );
    expect(isSafeRedirectUrl("http://127.0.0.1:4173/callback")).toBe(true);
    expect(isSafeRedirectUrl("/consent?client_id=c1")).toBe(true);
    expect(isSafeRedirectUrl("//evil.example/cb")).toBe(false);
    expect(isSafeRedirectUrl("/.//evil.example/cb")).toBe(false);
    expect(isSafeRedirectUrl("/a/..//evil.example/cb")).toBe(false);
    expect(isSafeRedirectUrl("/%2e//evil.example/cb")).toBe(false);
    expect(isSafeRedirectUrl("/\\evil.example")).toBe(false);
    expect(isSafeRedirectUrl("/\t/evil.example")).toBe(false);
    expect(isSafeRedirectUrl("/\n/evil.example")).toBe(false);
    expect(isSafeRedirectUrl("/\u0000/evil.example")).toBe(false);
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeRedirectUrl("")).toBe(false);
  });
});
