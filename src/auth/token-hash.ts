export async function hashBearerToken(rawToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawToken);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Computes unpadded base64url(SHA-256(token)) matching `@better-auth/oauth-provider`'s
 * `storeToken("hashed", token)` format for `oauthAccessToken.token`.
 */
export async function hashOAuthOpaqueToken(rawToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawToken);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function generateWorkerBearerToken(): Promise<{
  readonly plaintextToken: string;
  readonly tokenHash: string;
}> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const plaintextToken = `bbw_${hex}`;
  const tokenHash = await hashBearerToken(plaintextToken);
  return { plaintextToken, tokenHash };
}
