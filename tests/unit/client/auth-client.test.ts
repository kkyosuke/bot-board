import { describe, expect, test } from "bun:test";

import { extractSignedOAuthQuery, requiresForcedOAuthReauth } from "@/client/api/auth-client";

describe("Client OAuth signed query & forced re-authentication helpers (Sec-M3)", () => {
  test("extractSignedOAuthQuery keeps only ba_param-signed entries plus sig and ba_param", () => {
    const search =
      "?client_id=client_mcp_1&scope=openid+tasks%3Aread&ba_iat=1760000000000&ba_param=client_id&ba_param=scope&ba_param=ba_iat&ba_param=ba_param&utm_source=chatgpt&next=%2Fevil&sig=hmac_sig_123";

    const extracted = extractSignedOAuthQuery(search);
    expect(extracted).not.toBeNull();
    const parsed = new URLSearchParams(extracted ?? "");
    expect(parsed.get("client_id")).toBe("client_mcp_1");
    expect(parsed.get("scope")).toBe("openid tasks:read");
    expect(parsed.get("ba_iat")).toBe("1760000000000");
    expect(parsed.get("sig")).toBe("hmac_sig_123");
    expect(parsed.getAll("ba_param")).toEqual(["client_id", "scope", "ba_iat", "ba_param"]);
    expect(parsed.has("utm_source")).toBe(false);
    expect(parsed.has("next")).toBe(false);
  });

  test("extractSignedOAuthQuery returns null when sig is missing and preserves params when ba_param is absent", () => {
    expect(extractSignedOAuthQuery("")).toBeNull();
    expect(extractSignedOAuthQuery("?client_id=c1&scope=tasks:read")).toBeNull();

    const legacy = extractSignedOAuthQuery("?client_id=c1&scope=tasks%3Aread&sig=legacy_sig");
    expect(legacy).not.toBeNull();
    const parsed = new URLSearchParams(legacy ?? "");
    expect(parsed.get("client_id")).toBe("c1");
    expect(parsed.get("sig")).toBe("legacy_sig");
  });

  test("requiresForcedOAuthReauth detects prompt=login, prompt=login consent, max_age, and reauth=1", () => {
    expect(requiresForcedOAuthReauth("?client_id=c1&prompt=login&sig=s1")).toBe(true);
    expect(requiresForcedOAuthReauth("?client_id=c1&prompt=login+consent&sig=s1")).toBe(true);
    expect(requiresForcedOAuthReauth("?client_id=c1&max_age=0&sig=s1")).toBe(true);
    expect(requiresForcedOAuthReauth("?reauth=1&next=%2Fconsent")).toBe(true);

    // Non-reauth queries must return false
    expect(requiresForcedOAuthReauth("")).toBe(false);
    expect(requiresForcedOAuthReauth("?client_id=c1&prompt=consent&sig=s1")).toBe(false);
    expect(requiresForcedOAuthReauth("?prompt=login")).toBe(false);
    expect(requiresForcedOAuthReauth("?next=%2Fconsent%3Fclient_id%3Dc1")).toBe(false);
  });
});
