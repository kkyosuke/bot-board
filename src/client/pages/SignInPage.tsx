import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import {
  checkOwnerAuthStatus,
  extractSignedOAuthQuery,
  requiresForcedOAuthReauth,
  signOutOwner,
  startGithubOAuthSignIn,
} from "../api/auth-client";
import { isSafeRedirectUrl, normalizeSafeNextPath } from "../router";

export interface SignInPageProps {
  readonly search: string;
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

type SignInViewState = "loading" | "normal" | "non_owner" | "approved" | "error";

function resolvePostLoginDestination(
  search: string,
  signedOAuthQuery: string | null,
): {
  readonly nextPath: string;
  readonly isOAuthFlow: boolean;
} {
  const params = new URLSearchParams(search);
  const nextParam = params.get("next");
  if (nextParam !== null && nextParam.trim() !== "") {
    const safeNext = normalizeSafeNextPath(nextParam);
    return { nextPath: safeNext, isOAuthFlow: safeNext.startsWith("/consent") };
  }
  // Better Auth redirects unauthenticated /api/auth/oauth2/authorize requests to /sign-in?<signed-oauth-query>
  if (params.has("client_id") && signedOAuthQuery !== null) {
    return {
      nextPath: normalizeSafeNextPath(`/consent?${signedOAuthQuery}`),
      isOAuthFlow: true,
    };
  }
  return { nextPath: "/", isOAuthFlow: false };
}

function readQueryErrorNotice(
  search: string,
): { readonly kind: "non_owner" | "error"; readonly message: string } | null {
  const params = new URLSearchParams(search);
  const errorParam = params.get("error")?.trim() ?? "";
  if (errorParam === "") {
    return null;
  }
  if (errorParam.toLowerCase().includes("forbidden") || errorParam === "NOT_AUTHORIZED") {
    return {
      kind: "non_owner",
      message:
        "OWNER_GITHUB_ID と一致しないアカウントのため、サインインを拒否しました（単一オーナー制約）。",
    };
  }
  return {
    kind: "error",
    message: `GitHub OAuth 認証が完了しませんでした（${errorParam}）。オーナーの GitHub アカウントで再度サインインしてください。`,
  };
}

export function SignInPage(props: SignInPageProps): ReactElement {
  const { search, onNavigate } = props;
  const signedOAuthQuery = useMemo(() => extractSignedOAuthQuery(search), [search]);
  const needsForcedReauth = useMemo(() => requiresForcedOAuthReauth(search), [search]);
  const destination = useMemo(
    () => resolvePostLoginDestination(search, signedOAuthQuery),
    [search, signedOAuthQuery],
  );
  const queryError = useMemo(() => readQueryErrorNotice(search), [search]);

  const [viewState, setViewState] = useState<SignInViewState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);
  const [isAlreadySignedInReauth, setIsAlreadySignedInReauth] = useState<boolean>(false);
  const [statusNote, setStatusNote] = useState<string>("Better Auth セッションを確認しています…");

  const loadAuthState = useCallback(async (): Promise<void> => {
    setViewState("loading");
    setIsAlreadySignedInReauth(false);
    setStatusNote("Better Auth セッションを確認しています…");
    const result = await checkOwnerAuthStatus();
    if (result.kind === "owner") {
      if (needsForcedReauth) {
        setIsAlreadySignedInReauth(true);
        setViewState("normal");
        setErrorMessage("");
        setStatusNote(
          "接続元クライアントから再認証（prompt=login / max_age）が要求されています。GitHub で再サインインしてください。",
        );
        return;
      }
      setViewState("approved");
      setErrorMessage("");
      setStatusNote("単一オーナーセッション（OwnerContext）を確認しました。");
      return;
    }
    if (result.kind === "non_owner") {
      setViewState("non_owner");
      setErrorMessage(result.message);
      setStatusNote("403 NOT_AUTHORIZED: 許可された単一オーナー以外のアカウントです。");
      return;
    }
    if (queryError !== null) {
      setViewState(queryError.kind);
      setErrorMessage(queryError.message);
      setStatusNote("オーナーの GitHub アカウントで再試行してください。");
      return;
    }
    if (result.kind === "error") {
      setViewState("error");
      setErrorMessage(result.message);
      setStatusNote("接続エラーが発生しました。再試行してください。");
      return;
    }
    setViewState("normal");
    setErrorMessage("");
    setStatusNote(
      destination.isOAuthFlow
        ? "サインイン完了後、OAuth 2.1 同意画面（/consent）へ戻ります。"
        : "サインイン完了後、判断カード画面（/）へ移動します。",
    );
  }, [destination.isOAuthFlow, needsForcedReauth, queryError]);

  useEffect(() => {
    void loadAuthState();
  }, [loadAuthState]);

  const handleGithubSignIn = useCallback(async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setStatusNote("GitHub OAuth 認証ページへ移動しています…");
    const callbackURL =
      typeof window !== "undefined"
        ? `${window.location.origin}${destination.nextPath}`
        : destination.nextPath;
    const errorCallbackURL =
      typeof window !== "undefined" ? `${window.location.origin}/sign-in` : "/sign-in";
    const res = await startGithubOAuthSignIn(
      callbackURL,
      errorCallbackURL,
      signedOAuthQuery ?? undefined,
    );
    if (res.ok && isSafeRedirectUrl(res.url)) {
      window.location.assign(res.url);
      return;
    }
    setIsSubmitting(false);
    setViewState("error");
    setErrorMessage(res.ok ? "不正なリダイレクト先が返却されました。" : res.message);
    setStatusNote("GitHub OAuth の開始に失敗しました。設定を確認して再試行してください。");
  }, [destination.nextPath, isSubmitting, signedOAuthQuery]);

  const handleSignOut = useCallback(async (): Promise<void> => {
    if (isSigningOut) {
      return;
    }
    setIsSigningOut(true);
    const res = await signOutOwner();
    setIsSigningOut(false);
    if (!res.ok) {
      setViewState("error");
      setErrorMessage(res.message);
      setStatusNote("サインアウトに失敗しました。再試行してください。");
      return;
    }
    setIsAlreadySignedInReauth(false);
    setViewState("normal");
    setErrorMessage("");
    setStatusNote("サインアウトしました。オーナーの GitHub アカウントで再度サインインできます。");
  }, [isSigningOut]);

  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-[1040px] flex-col justify-center px-3 py-5 sm:px-5 sm:py-8"
      data-testid="sign-in-page"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm font-black"
            style={{
              backgroundColor: "var(--accent-primary)",
              color: "var(--accent-primary-ink)",
            }}
            aria-hidden="true"
          >
            B
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight">bot-board</h1>
            <p className="truncate text-xs" style={{ color: "var(--ink-muted)" }}>
              個人ワークスペース・単一オーナー認証
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate("/")}
          className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold"
          style={{
            borderColor: "var(--border-default)",
            backgroundColor: "var(--surface-card)",
            color: "var(--ink-primary)",
          }}
        >
          判断画面へ戻る
        </button>
      </header>

      {viewState === "loading" ? (
        <section
          aria-busy="true"
          data-testid="sign-in-loading"
          className="mx-auto w-full max-w-md space-y-4 rounded-2xl border p-5 bb-card-shadow"
          style={{
            borderColor: "var(--border-default)",
            backgroundColor: "var(--surface-card)",
          }}
        >
          <div
            className="h-6 w-40 rounded-lg"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          />
          <div
            className="h-4 w-full rounded"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          />
          <div
            className="h-12 w-full rounded-xl"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          />
          <p
            role="status"
            aria-live="polite"
            className="text-center text-xs"
            style={{ color: "var(--ink-muted)" }}
          >
            {statusNote}
          </p>
        </section>
      ) : viewState === "approved" ? (
        <section
          data-testid="sign-in-approved"
          className="mx-auto w-full max-w-md space-y-4 rounded-2xl border p-5 bb-card-shadow"
          style={{
            borderColor: "var(--tone-accept-border)",
            backgroundColor: "var(--surface-card)",
          }}
        >
          <div className="space-y-1.5">
            <span
              className="inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold"
              style={{
                borderColor: "var(--tone-accept-border)",
                backgroundColor: "var(--tone-accept-bg)",
                color: "var(--tone-accept)",
              }}
            >
              サインイン済（OwnerContext 発行済）
            </span>
            <h2 className="text-base font-bold">オーナー認証が完了しています</h2>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              単一ワークスペースのブートストラップを確認しました。元の遷移先へ安全に進めます。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              data-testid="sign-in-continue-btn"
              onClick={() => onNavigate(destination.nextPath)}
              className="inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              {destination.isOAuthFlow ? "/consent へ進む" : "判断画面へ進む"}
            </button>
            <button
              type="button"
              onClick={() => onNavigate("/settings")}
              className="inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-4 text-xs font-semibold"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-subtle)",
                color: "var(--ink-primary)",
              }}
            >
              設定を開く
            </button>
          </div>
          <button
            type="button"
            data-testid="sign-out-btn"
            disabled={isSigningOut}
            onClick={() => {
              void handleSignOut();
            }}
            className="inline-flex min-h-[48px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl border px-4 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
              color: "var(--ink-muted)",
            }}
          >
            {isSigningOut ? "サインアウト中…" : "サインアウト"}
          </button>
        </section>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:gap-5">
          <section
            className="space-y-4 rounded-2xl border p-4 bb-card-shadow sm:p-5 lg:col-span-7"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div className="space-y-1">
              <div
                className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                style={{
                  borderColor: "var(--border-default)",
                  backgroundColor: "var(--surface-subtle)",
                  color: "var(--ink-primary)",
                }}
              >
                bot-board ・ 個人ワークスペース
              </div>
              <h2 className="text-lg font-bold tracking-tight">オーナー サインイン</h2>
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                判断カードの採用・見送り、Bot OAuth
                同意、緊急停止は許可された単一オーナーのみ実行できます。
              </p>
            </div>

            {isAlreadySignedInReauth ? (
              <div
                role="status"
                data-testid="sign-in-reauth-notice"
                className="space-y-1 rounded-xl border p-3 text-xs"
                style={{
                  borderColor: "var(--tone-info-border)",
                  backgroundColor: "var(--tone-info-bg)",
                }}
              >
                <div className="font-bold">再認証が必要です（prompt=login / max_age）</div>
                <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                  接続元 OAuth クライアントが最新の再認証を要求しています。下のボタンからオーナーの
                  GitHub アカウントで再サインインしてください。
                </p>
              </div>
            ) : null}

            {viewState === "non_owner" ? (
              <div
                role="alert"
                data-testid="sign-in-non-owner-alert"
                className="space-y-2 rounded-xl border p-3 text-xs"
                style={{
                  borderColor: "var(--tone-decline-border)",
                  backgroundColor: "var(--tone-decline-bg)",
                }}
              >
                <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
                  403 NOT_AUTHORIZED: オーナー以外の登録・操作は禁止されています
                </div>
                <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                  {errorMessage}
                </p>
                <button
                  type="button"
                  data-testid="sign-out-btn"
                  disabled={isSigningOut}
                  onClick={() => {
                    void handleSignOut();
                  }}
                  className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-card)",
                    color: "var(--ink-primary)",
                  }}
                >
                  {isSigningOut ? "サインアウト中…" : "現在のセッションをサインアウト"}
                </button>
              </div>
            ) : viewState === "error" ? (
              <div
                role="alert"
                data-testid="sign-in-error-alert"
                className="space-y-1 rounded-xl border p-3 text-xs"
                style={{
                  borderColor: "var(--tone-warn-border)",
                  backgroundColor: "var(--tone-warn-bg)",
                }}
              >
                <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                  サインインエラー / セッション確認失敗
                </div>
                <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                  {errorMessage}
                </p>
              </div>
            ) : null}

            <div className="space-y-2.5">
              <button
                type="button"
                data-testid="github-sign-in-btn"
                disabled={isSubmitting}
                onClick={() => {
                  void handleGithubSignIn();
                }}
                className="inline-flex min-h-[48px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-ink)",
                }}
              >
                {isSubmitting
                  ? "GitHub へ移動中…"
                  : isAlreadySignedInReauth
                    ? "GitHub で再認証する"
                    : "GitHub でサインイン（MVP 認証方式）"}
              </button>
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                ※ Passkey 等の追加認証方式は MVP
                後続で拡張予定。自由サインアップはサーバー側で無効化されています。
              </p>
            </div>

            <div
              role="status"
              aria-live="polite"
              className="rounded-xl border p-2.5 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--surface-subtle)",
                color: "var(--ink-muted)",
              }}
            >
              {statusNote}
            </div>
          </section>

          <aside
            className="space-y-2.5 rounded-2xl border p-4 text-xs lg:col-span-5"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div className="font-bold">認可境界（BOT-02・S3/S4 契約）</div>
            <ul
              className="list-disc space-y-1.5 pl-4 leading-relaxed"
              style={{ color: "var(--ink-muted)" }}
            >
              <li>
                <code className="font-mono">OWNER_GITHUB_ID</code>{" "}
                一致時のみオーナーアカウントを許可
              </li>
              <li>
                初回サインイン時に単一 <code className="font-mono">workspaces</code>{" "}
                行を自動作成（UNIQUE 制約）
              </li>
              <li>
                Human API（<code className="font-mono">/api/human/*</code>）はセッション + CSRF +
                OwnerContext を強制
              </li>
            </ul>
          </aside>
        </div>
      )}
    </div>
  );
}
