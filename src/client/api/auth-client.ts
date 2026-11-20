import { BOT_SCOPES, type BotScope } from "@/domain";

export type OwnerAuthCheckResult =
  | { readonly kind: "owner"; readonly workspaceId: string; readonly isPaused: boolean }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "non_owner"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export interface OAuthConsentContextView {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientUri: string | null;
  readonly redirectUris: readonly string[];
  readonly requestedBotScopes: readonly BotScope[];
  readonly otherRequestedScopes: readonly string[];
  readonly existingBotId: string | null;
  readonly existingStatus: "active" | "paused" | "revoked" | null;
  readonly existingScopes: readonly BotScope[];
}

export type OAuthConsentContextFetchResult =
  | { readonly kind: "ok"; readonly context: OAuthConsentContextView }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "non_owner"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export type OAuthConsentSubmitResult =
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "non_owner"; readonly message: string }
  | { readonly kind: "revoked"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const val: unknown = record[key];
  return typeof val === "string" ? val : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const val: unknown = record[key];
  return typeof val === "boolean" ? val : null;
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const val: unknown = record[key];
  if (!Array.isArray(val)) {
    return [];
  }
  return val.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function filterBotScopes(values: readonly string[]): readonly BotScope[] {
  const result: BotScope[] = [];
  for (const val of values) {
    const matched = BOT_SCOPES.find((scope) => scope === val);
    if (matched !== undefined && !result.includes(matched)) {
      result.push(matched);
    }
  }
  return result;
}

function parseBotStatus(raw: string | null): "active" | "paused" | "revoked" | null {
  if (raw === "active" || raw === "paused" || raw === "revoked") {
    return raw;
  }
  return null;
}

async function readJsonSafely(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function checkOwnerAuthStatus(): Promise<OwnerAuthCheckResult> {
  try {
    const res = await fetch("/api/human/workspace", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const body = await readJsonSafely(res);
    if (res.status === 200) {
      return {
        kind: "owner",
        workspaceId: readString(body, "id") ?? "",
        isPaused: readBoolean(body, "is_paused") === true,
      };
    }
    if (res.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (res.status === 403) {
      return {
        kind: "non_owner",
        message: readString(body, "message") ?? "オーナー以外のアカウントではアクセスできません。",
      };
    }
    return {
      kind: "error",
      message: readString(body, "message") ?? `認証状態の確認に失敗しました (HTTP ${res.status})。`,
    };
  } catch {
    return {
      kind: "error",
      message: "サーバーへ接続できません。ネットワーク状態を確認して再試行してください。",
    };
  }
}

export async function startGithubOAuthSignIn(
  callbackURL: string,
  errorCallbackURL?: string,
): Promise<
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string }
> {
  try {
    const res = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL,
        ...(errorCallbackURL !== undefined ? { errorCallbackURL } : {}),
      }),
    });
    const body = await readJsonSafely(res);
    const url = readString(body, "url");
    if (res.ok && url !== null && url.trim() !== "") {
      return { ok: true, url };
    }
    return {
      ok: false,
      message:
        readString(body, "message") ??
        readString(body, "error_description") ??
        `GitHub OAuth の開始に失敗しました (HTTP ${res.status})。`,
    };
  } catch {
    return {
      ok: false,
      message: "GitHub OAuth リクエストの送信に失敗しました。接続を確認してください。",
    };
  }
}

export async function fetchOAuthConsentContext(
  clientId: string,
  scope: string | null,
): Promise<OAuthConsentContextFetchResult> {
  const params = new URLSearchParams({ client_id: clientId });
  if (scope !== null && scope.trim() !== "") {
    params.set("scope", scope.trim());
  }

  try {
    const res = await fetch(`/api/human/oauth/consent-context?${params.toString()}`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const body = await readJsonSafely(res);
    if (res.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (res.status === 403) {
      return {
        kind: "non_owner",
        message: readString(body, "message") ?? "オーナー以外の OAuth 同意操作は禁止されています。",
      };
    }
    if (!res.ok) {
      return {
        kind: "error",
        message:
          readString(body, "message") ??
          `OAuth クライアント情報の取得に失敗しました (HTTP ${res.status})。`,
      };
    }

    const resolvedClientId = readString(body, "client_id") ?? clientId;
    const requestedBotScopes = filterBotScopes(readStringArray(body, "requested_bot_scopes"));

    return {
      kind: "ok",
      context: {
        clientId: resolvedClientId,
        clientName: readString(body, "client_name") ?? resolvedClientId,
        clientUri: readString(body, "client_uri"),
        redirectUris: readStringArray(body, "redirect_uris"),
        requestedBotScopes,
        otherRequestedScopes: readStringArray(body, "other_requested_scopes"),
        existingBotId: readString(body, "existing_bot_id"),
        existingStatus: parseBotStatus(readString(body, "existing_status")),
        existingScopes: filterBotScopes(readStringArray(body, "existing_scopes")),
      },
    };
  } catch {
    return {
      kind: "error",
      message: "OAuth クライアント情報の取得中に通信エラーが発生しました。",
    };
  }
}

export async function submitOAuthConsentDecision(input: {
  readonly accept: boolean;
  readonly scope?: string;
  readonly oauthQuery: string;
}): Promise<OAuthConsentSubmitResult> {
  try {
    const res = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        accept: input.accept,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        oauth_query: input.oauthQuery,
      }),
    });
    const body = await readJsonSafely(res);
    if (res.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (res.status === 403) {
      const msg = readString(body, "message") ?? "";
      if (msg.toLowerCase().includes("revoked")) {
        return {
          kind: "revoked",
          message: "この OAuth クライアントは失効済（revoked）のため再許可できません。",
        };
      }
      return {
        kind: "non_owner",
        message: msg || "オーナー以外のアカウントでは同意を確定できません。",
      };
    }
    const url = readString(body, "url");
    if (res.ok && readBoolean(body, "redirect") === true && url !== null) {
      return { kind: "redirect", url };
    }
    return {
      kind: "error",
      message:
        readString(body, "error_description") ??
        readString(body, "message") ??
        `OAuth 同意処理に失敗しました (HTTP ${res.status})。`,
    };
  } catch {
    return {
      kind: "error",
      message: "OAuth 同意リクエストの送信中に通信エラーが発生しました。",
    };
  }
}
