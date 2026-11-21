import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";

import { BOT_SCOPES, type BotScope } from "@/domain";

export type OwnerAuthCheckResult =
  | { readonly kind: "owner"; readonly workspaceId: string; readonly isPaused: boolean }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "non_owner"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export type OwnerBootstrapStatusResult =
  | { readonly ok: true; readonly initialized: boolean }
  | { readonly ok: false; readonly message: string };

export type OwnerAuthActionResult =
  | { readonly ok: true; readonly redirectUrl: string | null }
  | { readonly ok: false; readonly kind: "non_owner" | "error"; readonly message: string };

export interface OwnerPasskeyDto {
  readonly id: string;
  readonly name: string | null;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: string | null;
}

export type PasskeyListResult =
  | { readonly ok: true; readonly passkeys: readonly OwnerPasskeyDto[] }
  | { readonly ok: false; readonly status: number; readonly message: string };

export type PasskeyMutationResult =
  | { readonly ok: true; readonly passkey?: OwnerPasskeyDto }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string | null;
      readonly message: string;
    };

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

async function readRawJsonSafely(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isRequestOptionsJson(value: unknown): value is PublicKeyCredentialRequestOptionsJSON {
  return isRecord(value) && typeof value["challenge"] === "string";
}

function isCreationOptionsJson(value: unknown): value is PublicKeyCredentialCreationOptionsJSON {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["challenge"] === "string" &&
    isRecord(value["rp"]) &&
    isRecord(value["user"]) &&
    Array.isArray(value["pubKeyCredParams"])
  );
}

function parsePasskeyRecord(value: unknown): OwnerPasskeyDto | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value, "id");
  if (id === null || id.trim() === "") {
    return null;
  }
  const rawCreatedAt: unknown = value["createdAt"];
  let createdAt: string | null = null;
  if (typeof rawCreatedAt === "string" && rawCreatedAt.trim() !== "") {
    createdAt = rawCreatedAt;
  } else if (typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt)) {
    createdAt = new Date(rawCreatedAt).toISOString();
  }
  return {
    id,
    name: readString(value, "name"),
    deviceType: readString(value, "deviceType") ?? "multiDevice",
    backedUp: readBoolean(value, "backedUp") === true,
    createdAt,
  };
}

function formatPasskeyErrorMessage(
  status: number,
  body: Record<string, unknown>,
  fallback: string,
): string {
  const code = readString(body, "code") ?? readString(body, "error") ?? "";
  if (code === "SESSION_NOT_FRESH" || code === "FRESH_SESSION_REQUIRED") {
    return "パスキーを追加登録するには、一度サインアウトして再サインインしてください（セッション新鮮度要件）。";
  }
  if (status === 403 || code === "NOT_AUTHORIZED") {
    return (
      readString(body, "message") ??
      "OWNER_EMAIL と一致しないか、既にオーナーが初期化済みのため操作が拒否されました。"
    );
  }
  return readString(body, "message") ?? readString(body, "error_description") ?? fallback;
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

export async function fetchOwnerBootstrapStatus(): Promise<OwnerBootstrapStatusResult> {
  try {
    const res = await fetch("/api/auth/owner-status", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const body = await readJsonSafely(res);
    const initialized = readBoolean(body, "initialized");
    if (res.ok && initialized !== null) {
      return { ok: true, initialized };
    }
    return {
      ok: false,
      message:
        readString(body, "message") ??
        `オーナー初期化状態の確認に失敗しました (HTTP ${res.status})。`,
    };
  } catch {
    return {
      ok: false,
      message: "オーナー初期化状態の確認に失敗しました。接続を確認してください。",
    };
  }
}

/**
 * Extracts only the Better Auth signed OAuth query parameters (filtering by `ba_param`
 * when present) so unrelated query parameters never invalidate the HMAC signature.
 */
export function extractSignedOAuthQuery(search: string): string | null {
  const normalized = search.startsWith("?") ? search.slice(1) : search;
  if (normalized.trim() === "") {
    return null;
  }
  const params = new URLSearchParams(normalized);
  if (!params.has("sig")) {
    return null;
  }
  const signedParamNames = params.getAll("ba_param").filter((name) => name.trim() !== "");
  if (signedParamNames.length === 0) {
    return normalized;
  }
  const allowedNames = new Set<string>(signedParamNames);
  const filtered = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === "sig" || key === "ba_param" || allowedNames.has(key)) {
      filtered.append(key, value);
    }
  }
  return filtered.toString();
}

/**
 * Returns true when an incoming OAuth 2.1 login redirect requires fresh re-authentication
 * (`prompt=login` or `max_age`), preventing an infinite redirect loop for already-signed-in owners.
 */
export function requiresForcedOAuthReauth(search: string): boolean {
  const normalized = search.startsWith("?") ? search.slice(1) : search;
  if (normalized.trim() === "") {
    return false;
  }
  const params = new URLSearchParams(normalized);
  if (params.get("reauth") === "1") {
    return true;
  }
  if (!params.has("client_id") || !params.has("sig")) {
    return false;
  }
  const promptTokens = (params.get("prompt") ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (promptTokens.includes("login")) {
    return true;
  }
  const maxAge = params.get("max_age");
  return maxAge !== null && maxAge.trim() !== "";
}

export async function signUpOwnerWithPassword(input: {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly oauthQuery?: string;
}): Promise<OwnerAuthActionResult> {
  const trimmedEmail = input.email.trim();
  const displayName = (input.name?.trim() || trimmedEmail.split("@")[0] || "Owner").slice(0, 80);
  try {
    const res = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: trimmedEmail,
        password: input.password,
        name: displayName,
        ...(input.oauthQuery !== undefined && input.oauthQuery.trim() !== ""
          ? { oauth_query: input.oauthQuery.trim() }
          : {}),
      }),
    });
    const body = await readJsonSafely(res);
    if (res.ok) {
      const redirectUrl = readBoolean(body, "redirect") === true ? readString(body, "url") : null;
      return { ok: true, redirectUrl };
    }
    if (res.status === 403) {
      return {
        ok: false,
        kind: "non_owner",
        message: formatPasskeyErrorMessage(
          res.status,
          body,
          "OWNER_EMAIL と一致しないか、既にオーナーが登録済みのため作成できません。",
        ),
      };
    }
    return {
      ok: false,
      kind: "error",
      message: formatPasskeyErrorMessage(
        res.status,
        body,
        `オーナーアカウントの作成に失敗しました (HTTP ${res.status})。`,
      ),
    };
  } catch {
    return {
      ok: false,
      kind: "error",
      message: "オーナー登録リクエストの送信に失敗しました。接続を確認してください。",
    };
  }
}

export async function signInOwnerWithPassword(input: {
  readonly email: string;
  readonly password: string;
  readonly oauthQuery?: string;
}): Promise<OwnerAuthActionResult> {
  try {
    const res = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: input.email.trim(),
        password: input.password,
        ...(input.oauthQuery !== undefined && input.oauthQuery.trim() !== ""
          ? { oauth_query: input.oauthQuery.trim() }
          : {}),
      }),
    });
    const body = await readJsonSafely(res);
    if (res.ok) {
      const redirectUrl = readBoolean(body, "redirect") === true ? readString(body, "url") : null;
      return { ok: true, redirectUrl };
    }
    if (res.status === 403) {
      return {
        ok: false,
        kind: "non_owner",
        message: formatPasskeyErrorMessage(
          res.status,
          body,
          "OWNER_EMAIL と一致しないアカウントのためサインインできません。",
        ),
      };
    }
    if (res.status === 401) {
      return {
        ok: false,
        kind: "error",
        message: "メールアドレスまたはパスワードが正しくありません。",
      };
    }
    return {
      ok: false,
      kind: "error",
      message: formatPasskeyErrorMessage(
        res.status,
        body,
        `サインインに失敗しました (HTTP ${res.status})。`,
      ),
    };
  } catch {
    return {
      ok: false,
      kind: "error",
      message: "サインインリクエストの送信に失敗しました。接続を確認してください。",
    };
  }
}

export async function signInOwnerWithPasskey(oauthQuery?: string): Promise<OwnerAuthActionResult> {
  if (!browserSupportsWebAuthn()) {
    return {
      ok: false,
      kind: "error",
      message:
        "このブラウザはパスキー（WebAuthn）に対応していません。メールアドレス＋パスワードでサインインしてください。",
    };
  }

  try {
    const optionsRes = await fetch("/api/auth/passkey/generate-authenticate-options", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const rawOptions = await readRawJsonSafely(optionsRes);
    if (!optionsRes.ok || !isRequestOptionsJson(rawOptions)) {
      const errBody = isRecord(rawOptions) ? rawOptions : {};
      return {
        ok: false,
        kind: "error",
        message: formatPasskeyErrorMessage(
          optionsRes.status,
          errBody,
          `パスキー認証オプションの取得に失敗しました (HTTP ${optionsRes.status})。`,
        ),
      };
    }

    let authResp;
    try {
      authResp = await startAuthentication({ optionsJSON: rawOptions });
    } catch (err) {
      if (err instanceof WebAuthnError && err.code === "ERROR_CEREMONY_ABORTED") {
        return {
          ok: false,
          kind: "error",
          message: "パスキー認証がキャンセルされました。",
        };
      }
      return {
        ok: false,
        kind: "error",
        message:
          "パスキー認証を完了できませんでした。登録済み端末か確認するか、パスワードでサインインしてください。",
      };
    }

    const { clientExtensionResults: _ignored, ...responseBody } = authResp;
    const verifyRes = await fetch("/api/auth/passkey/verify-authentication", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        response: responseBody,
        ...(oauthQuery !== undefined && oauthQuery.trim() !== ""
          ? { oauth_query: oauthQuery.trim() }
          : {}),
      }),
    });
    const verifyBody = await readJsonSafely(verifyRes);
    if (verifyRes.ok) {
      const redirectUrl =
        readBoolean(verifyBody, "redirect") === true ? readString(verifyBody, "url") : null;
      return { ok: true, redirectUrl };
    }
    if (verifyRes.status === 403) {
      return {
        ok: false,
        kind: "non_owner",
        message: formatPasskeyErrorMessage(
          verifyRes.status,
          verifyBody,
          "OWNER_EMAIL と一致しないアカウントのためサインインできません。",
        ),
      };
    }
    return {
      ok: false,
      kind: "error",
      message: formatPasskeyErrorMessage(
        verifyRes.status,
        verifyBody,
        `パスキー検証に失敗しました (HTTP ${verifyRes.status})。`,
      ),
    };
  } catch {
    return {
      ok: false,
      kind: "error",
      message: "パスキー認証の通信中にエラーが発生しました。接続を確認してください。",
    };
  }
}

export async function listOwnerPasskeys(): Promise<PasskeyListResult> {
  try {
    const res = await fetch("/api/auth/passkey/list-user-passkeys", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const raw = await readRawJsonSafely(res);
    if (!res.ok) {
      const errBody = isRecord(raw) ? raw : {};
      return {
        ok: false,
        status: res.status,
        message: formatPasskeyErrorMessage(
          res.status,
          errBody,
          `パスキー一覧の取得に失敗しました (HTTP ${res.status})。`,
        ),
      };
    }
    if (!Array.isArray(raw)) {
      return { ok: true, passkeys: [] };
    }
    const passkeys: OwnerPasskeyDto[] = [];
    for (const item of raw) {
      const parsed = parsePasskeyRecord(item);
      if (parsed !== null) {
        passkeys.push(parsed);
      }
    }
    return { ok: true, passkeys };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "パスキー一覧の取得中に通信エラーが発生しました。",
    };
  }
}

export async function registerOwnerPasskey(name?: string): Promise<PasskeyMutationResult> {
  if (!browserSupportsWebAuthn()) {
    return {
      ok: false,
      status: 400,
      code: "WEBAUTHN_UNSUPPORTED",
      message: "このブラウザはパスキー（WebAuthn）に対応していません。",
    };
  }

  const trimmedName = name?.trim() ?? "";
  const query = trimmedName !== "" ? `?name=${encodeURIComponent(trimmedName)}` : "";
  try {
    const optionsRes = await fetch(`/api/auth/passkey/generate-register-options${query}`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const rawOptions = await readRawJsonSafely(optionsRes);
    if (!optionsRes.ok || !isCreationOptionsJson(rawOptions)) {
      const errBody = isRecord(rawOptions) ? rawOptions : {};
      return {
        ok: false,
        status: optionsRes.status,
        code: readString(errBody, "code") ?? readString(errBody, "error"),
        message: formatPasskeyErrorMessage(
          optionsRes.status,
          errBody,
          `パスキー登録オプションの取得に失敗しました (HTTP ${optionsRes.status})。`,
        ),
      };
    }

    let regResp;
    try {
      regResp = await startRegistration({ optionsJSON: rawOptions });
    } catch (err) {
      if (err instanceof WebAuthnError) {
        if (err.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
          return {
            ok: false,
            status: 400,
            code: err.code,
            message: "この端末のパスキーは既に登録されています。",
          };
        }
        if (err.code === "ERROR_CEREMONY_ABORTED") {
          return {
            ok: false,
            status: 400,
            code: err.code,
            message: "パスキー登録がキャンセルされました。",
          };
        }
      }
      return {
        ok: false,
        status: 400,
        code: "REGISTRATION_FAILED",
        message: "パスキー登録を完了できませんでした。生体認証または端末設定を確認してください。",
      };
    }

    const { clientExtensionResults: _ignored, ...responseBody } = regResp;
    const verifyRes = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        response: responseBody,
        ...(trimmedName !== "" ? { name: trimmedName } : {}),
      }),
    });
    const verifyBody = await readJsonSafely(verifyRes);
    if (!verifyRes.ok) {
      return {
        ok: false,
        status: verifyRes.status,
        code: readString(verifyBody, "code") ?? readString(verifyBody, "error"),
        message: formatPasskeyErrorMessage(
          verifyRes.status,
          verifyBody,
          `パスキーの登録検証に失敗しました (HTTP ${verifyRes.status})。`,
        ),
      };
    }

    const created = parsePasskeyRecord(verifyBody);
    return created !== null ? { ok: true, passkey: created } : { ok: true };
  } catch {
    return {
      ok: false,
      status: 0,
      code: "NETWORK_ERROR",
      message: "パスキー登録中に通信エラーが発生しました。",
    };
  }
}

export async function deleteOwnerPasskey(id: string): Promise<PasskeyMutationResult> {
  try {
    const res = await fetch("/api/auth/passkey/delete-passkey", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ id }),
    });
    const body = await readJsonSafely(res);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: readString(body, "code") ?? readString(body, "error"),
        message: formatPasskeyErrorMessage(
          res.status,
          body,
          `パスキーの削除に失敗しました (HTTP ${res.status})。`,
        ),
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      status: 0,
      code: "NETWORK_ERROR",
      message: "パスキー削除中に通信エラーが発生しました。",
    };
  }
}

export async function signOutOwner(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  try {
    const res = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });
    if (res.ok || res.status === 401) {
      return { ok: true };
    }
    const body = await readJsonSafely(res);
    return {
      ok: false,
      message: readString(body, "message") ?? `サインアウトに失敗しました (HTTP ${res.status})。`,
    };
  } catch {
    return {
      ok: false,
      message: "サインアウトリクエストの送信に失敗しました。接続を確認してください。",
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
