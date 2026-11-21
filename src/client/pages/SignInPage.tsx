import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  checkOwnerAuthStatus,
  extractSignedOAuthQuery,
  fetchOwnerBootstrapStatus,
  registerOwnerPasskey,
  requiresForcedOAuthReauth,
  signInOwnerWithPasskey,
  signInOwnerWithPassword,
  signOutOwner,
  signUpOwnerWithPassword,
} from "../api/auth-client";
import { isSafeRedirectUrl, normalizeSafeNextPath } from "../router";

export interface SignInPageProps {
  readonly search: string;
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

type SignInViewState =
  "loading" | "bootstrap" | "bootstrap_complete" | "normal" | "non_owner" | "approved" | "error";

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
        "OWNER_EMAIL と一致しないアカウントのため、サインインを拒否しました（単一オーナー制約）。",
    };
  }
  return {
    kind: "error",
    message: `オーナー認証が完了しませんでした（${errorParam}）。パスキーまたはメールアドレス＋パスワードで再度サインインしてください。`,
  };
}

export function SignInPage(props: SignInPageProps): ReactElement {
  const { search, onNavigate } = props;
  const formIdPrefix = useId();
  const signedOAuthQuery = useMemo(() => extractSignedOAuthQuery(search), [search]);
  const needsForcedReauth = useMemo(() => requiresForcedOAuthReauth(search), [search]);
  const destination = useMemo(
    () => resolvePostLoginDestination(search, signedOAuthQuery),
    [search, signedOAuthQuery],
  );
  const queryError = useMemo(() => readQueryErrorNotice(search), [search]);

  const [viewState, setViewState] = useState<SignInViewState>("loading");
  const [ownerInitialized, setOwnerInitialized] = useState<boolean>(true);
  const [statusCheckFailed, setStatusCheckFailed] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);
  const [isRegisteringPasskey, setIsRegisteringPasskey] = useState<boolean>(false);
  const [passkeyRegisteredNotice, setPasskeyRegisteredNotice] = useState<string>("");
  const [isAlreadySignedInReauth, setIsAlreadySignedInReauth] = useState<boolean>(false);
  const [showPasswordForm, setShowPasswordForm] = useState<boolean>(false);
  const [emailInput, setEmailInput] = useState<string>("");
  const [passwordInput, setPasswordInput] = useState<string>("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState<string>("");
  const [statusNote, setStatusNote] = useState<string>("Better Auth セッションを確認しています…");
  const loadSeqRef = useRef<number>(0);

  const completePostAuthNavigation = useCallback(
    (redirectUrl: string | null): void => {
      const trimmed = redirectUrl?.trim() ?? "";
      if (trimmed !== "") {
        if (trimmed.startsWith("/")) {
          onNavigate(normalizeSafeNextPath(trimmed), { replace: true });
          return;
        }
        if (isSafeRedirectUrl(trimmed)) {
          window.location.assign(trimmed);
          return;
        }
      }
      onNavigate(destination.nextPath, { replace: true });
    },
    [destination.nextPath, onNavigate],
  );

  const loadAuthState = useCallback(async (): Promise<void> => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setViewState("loading");
    setIsAlreadySignedInReauth(false);
    setStatusCheckFailed(false);
    setPasskeyRegisteredNotice("");
    setStatusNote("Better Auth セッションを確認しています…");

    const [result, bootstrapStatus] = await Promise.all([
      checkOwnerAuthStatus(),
      fetchOwnerBootstrapStatus(),
    ]);
    if (loadSeqRef.current !== seq) {
      return;
    }
    if (bootstrapStatus.ok) {
      setOwnerInitialized(bootstrapStatus.initialized);
    }

    if (result.kind === "owner") {
      if (needsForcedReauth) {
        setIsAlreadySignedInReauth(true);
        setViewState("normal");
        setErrorMessage("");
        setStatusNote(
          "接続元クライアントから再認証（prompt=login / max_age）が要求されています。パスキーまたはパスワードで再サインインしてください。",
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
      setStatusNote("許可されたオーナーアカウントで再試行してください。");
      return;
    }
    if (result.kind === "error") {
      setStatusCheckFailed(true);
      setViewState("error");
      setErrorMessage(result.message);
      setStatusNote("接続エラーが発生しました。再試行してください。");
      return;
    }
    if (!bootstrapStatus.ok) {
      setStatusCheckFailed(true);
      setViewState("error");
      setErrorMessage(bootstrapStatus.message);
      setStatusNote("オーナー初期化状態を取得できませんでした。再試行してください。");
      return;
    }
    if (!bootstrapStatus.initialized) {
      setViewState("bootstrap");
      setErrorMessage("");
      setStatusNote(
        "初回オーナー未登録です。OWNER_EMAIL に設定したメールアドレスでアカウントを作成してください。",
      );
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
    return () => {
      loadSeqRef.current += 1;
    };
  }, [loadAuthState]);

  const handlePasskeySignIn = useCallback(async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage("");
    setStatusNote("パスキー認証（Face ID / Touch ID）を待機しています…");
    const res = await signInOwnerWithPasskey(signedOAuthQuery ?? undefined);
    setIsSubmitting(false);
    if (res.ok) {
      setStatusNote("パスキー認証に成功しました。遷移しています…");
      completePostAuthNavigation(res.redirectUrl);
      return;
    }
    setViewState(res.kind);
    setErrorMessage(res.message);
    setStatusNote(
      "パスキーで認証できない場合は、下のメールアドレス＋パスワードでサインインできます。",
    );
  }, [completePostAuthNavigation, isSubmitting, signedOAuthQuery]);

  const handlePasswordSignIn = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (isSubmitting) {
        return;
      }
      const trimmedEmail = emailInput.trim();
      if (trimmedEmail === "" || !trimmedEmail.includes("@") || passwordInput === "") {
        setViewState("error");
        setErrorMessage("メールアドレスとパスワードを入力してください。");
        return;
      }

      setIsSubmitting(true);
      setErrorMessage("");
      setStatusNote("メールアドレス＋パスワードを検証しています…");
      const res = await signInOwnerWithPassword({
        email: trimmedEmail,
        password: passwordInput,
        ...(signedOAuthQuery !== null ? { oauthQuery: signedOAuthQuery } : {}),
      });
      setIsSubmitting(false);
      if (res.ok) {
        setPasswordInput("");
        setStatusNote("サインインに成功しました。遷移しています…");
        completePostAuthNavigation(res.redirectUrl);
        return;
      }
      setViewState(res.kind);
      setErrorMessage(res.message);
      setStatusNote("メールアドレスとパスワードを確認して再試行してください。");
    },
    [completePostAuthNavigation, emailInput, isSubmitting, passwordInput, signedOAuthQuery],
  );

  const handleOwnerBootstrapSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (isSubmitting) {
        return;
      }
      const trimmedEmail = emailInput.trim();
      if (trimmedEmail === "" || !trimmedEmail.includes("@")) {
        setErrorMessage("有効なオーナー メールアドレスを入力してください。");
        return;
      }
      if (passwordInput.length < 12) {
        setErrorMessage("パスワードは 12 文字以上で設定してください。");
        return;
      }
      if (passwordInput !== confirmPasswordInput) {
        setErrorMessage("確認用パスワードが一致していません。");
        return;
      }

      setIsSubmitting(true);
      setErrorMessage("");
      setStatusNote("初回オーナーアカウントを作成しています…");
      const res = await signUpOwnerWithPassword({
        email: trimmedEmail,
        password: passwordInput,
        ...(signedOAuthQuery !== null ? { oauthQuery: signedOAuthQuery } : {}),
      });
      setIsSubmitting(false);
      if (res.ok) {
        setOwnerInitialized(true);
        setPasswordInput("");
        setConfirmPasswordInput("");
        if (res.redirectUrl !== null) {
          completePostAuthNavigation(res.redirectUrl);
          return;
        }
        setViewState("bootstrap_complete");
        setErrorMessage("");
        setStatusNote(
          "オーナー作成と新規登録の永久ロックが完了しました。続けてパスキーを登録できます。",
        );
        return;
      }
      setErrorMessage(res.message);
      setStatusNote(
        res.kind === "non_owner"
          ? "403 NOT_AUTHORIZED: OWNER_EMAIL 設定と一致するメールアドレスのみ許可されます。"
          : "入力内容を確認して再試行してください。",
      );
    },
    [
      completePostAuthNavigation,
      confirmPasswordInput,
      emailInput,
      isSubmitting,
      passwordInput,
      signedOAuthQuery,
    ],
  );

  const handleBootstrapRegisterPasskey = useCallback(async (): Promise<void> => {
    if (isRegisteringPasskey) {
      return;
    }
    setIsRegisteringPasskey(true);
    setErrorMessage("");
    setStatusNote("この端末のパスキー（Face ID / Touch ID）を登録しています…");
    const res = await registerOwnerPasskey("メイン端末");
    setIsRegisteringPasskey(false);
    if (res.ok) {
      setPasskeyRegisteredNotice(
        "この端末のパスキーを登録しました。次回から 1 タップでサインインできます。",
      );
      setStatusNote("パスキー登録が完了しました。判断画面へ進めます。");
      return;
    }
    setErrorMessage(res.message);
    setStatusNote("パスキーはあとから /settings でも追加できます。");
  }, [isRegisteringPasskey]);

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
    setViewState(ownerInitialized ? "normal" : "bootstrap");
    setErrorMessage("");
    setStatusNote("サインアウトしました。パスキーまたはパスワードで再度サインインできます。");
  }, [isSigningOut, ownerInitialized]);

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
      ) : viewState === "bootstrap_complete" ? (
        <section
          data-testid="sign-in-bootstrap-complete"
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
              オーナー作成完了・新規登録ロック済
            </span>
            <h2 className="text-base font-bold">この端末のパスキーを登録しますか？</h2>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              次回から Face ID / Touch ID / 1Password だけで 1
              タップログインできるよう、いまパスキーを登録しておくと便利です。
            </p>
          </div>

          {passkeyRegisteredNotice !== "" ? (
            <div
              role="status"
              data-testid="bootstrap-passkey-registered"
              className="rounded-xl border p-3 text-xs font-semibold"
              style={{
                borderColor: "var(--tone-accept-border)",
                backgroundColor: "var(--tone-accept-bg)",
                color: "var(--tone-accept)",
              }}
            >
              {passkeyRegisteredNotice}
            </div>
          ) : null}

          {errorMessage !== "" ? (
            <div
              role="alert"
              data-testid="sign-in-error-alert"
              className="rounded-xl border p-3 text-xs"
              style={{
                borderColor: "var(--tone-warn-border)",
                backgroundColor: "var(--tone-warn-bg)",
                color: "var(--ink-primary)",
              }}
            >
              {errorMessage}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              data-testid="bootstrap-register-passkey-btn"
              disabled={isRegisteringPasskey}
              onClick={() => {
                void handleBootstrapRegisterPasskey();
              }}
              className={
                passkeyRegisteredNotice !== ""
                  ? "inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-4 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  : "inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50"
              }
              style={
                passkeyRegisteredNotice !== ""
                  ? {
                      borderColor: "var(--border-default)",
                      backgroundColor: "var(--surface-subtle)",
                      color: "var(--ink-primary)",
                    }
                  : {
                      backgroundColor: "var(--accent-primary)",
                      color: "var(--accent-primary-ink)",
                    }
              }
            >
              {isRegisteringPasskey
                ? "登録中…"
                : passkeyRegisteredNotice !== ""
                  ? "+ 別のパスキーを追加登録"
                  : "+ この端末のパスキーを登録"}
            </button>
            <button
              type="button"
              data-testid="sign-in-continue-btn"
              onClick={() => onNavigate(destination.nextPath, { replace: true })}
              className={
                passkeyRegisteredNotice !== ""
                  ? "inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold"
                  : "inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-4 text-xs font-semibold"
              }
              style={
                passkeyRegisteredNotice !== ""
                  ? {
                      backgroundColor: "var(--accent-primary)",
                      color: "var(--accent-primary-ink)",
                    }
                  : {
                      borderColor: "var(--border-default)",
                      backgroundColor: "var(--surface-subtle)",
                      color: "var(--ink-primary)",
                    }
              }
            >
              {destination.isOAuthFlow
                ? "/consent へ進む"
                : passkeyRegisteredNotice !== ""
                  ? "判断画面へ進む"
                  : "あとで（判断画面へ進む）"}
            </button>
          </div>
        </section>
      ) : viewState === "bootstrap" ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:gap-5">
          <section
            data-testid="sign-in-bootstrap"
            className="space-y-4 rounded-2xl border p-4 bb-card-shadow sm:p-5 lg:col-span-7"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <span
                  className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                  style={{
                    borderColor: "var(--tone-accept-border)",
                    backgroundColor: "var(--tone-accept-bg)",
                    color: "var(--tone-accept)",
                  }}
                >
                  初回オーナー登録（1回限り）
                </span>
                <h2 className="text-lg font-bold tracking-tight">オーナーアカウントを作成</h2>
              </div>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              設定済みの <code className="font-mono">OWNER_EMAIL</code>{" "}
              と一致するメールアドレスのみ登録できます。作成完了と同時に新規登録は永久ロックされ、続けてパスキー（Face
              ID / Touch ID）を登録できます。
            </p>

            {errorMessage !== "" ? (
              <div
                role="alert"
                data-testid="sign-in-error-alert"
                className="space-y-1 rounded-xl border p-3 text-xs"
                style={{
                  borderColor: "var(--tone-decline-border)",
                  backgroundColor: "var(--tone-decline-bg)",
                }}
              >
                <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
                  オーナー登録エラー
                </div>
                <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                  {errorMessage}
                </p>
              </div>
            ) : null}

            <form
              data-testid="owner-bootstrap-form"
              onSubmit={(event) => {
                void handleOwnerBootstrapSubmit(event);
              }}
              className="space-y-3"
            >
              <div className="space-y-1">
                <label
                  htmlFor={`${formIdPrefix}-boot-email`}
                  className="block text-xs font-semibold"
                >
                  オーナー メールアドレス
                </label>
                <input
                  id={`${formIdPrefix}-boot-email`}
                  data-testid="bootstrap-email-input"
                  type="email"
                  required
                  autoComplete="username"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="owner@example.com"
                  className="min-h-[44px] w-full rounded-xl border px-3 text-sm"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor={`${formIdPrefix}-boot-password`}
                  className="block text-xs font-semibold"
                >
                  パスワード（12文字以上・端末紛失時の予備）
                </label>
                <input
                  id={`${formIdPrefix}-boot-password`}
                  data-testid="bootstrap-password-input"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="12文字以上の安全なパスワード"
                  className="min-h-[44px] w-full rounded-xl border px-3 text-sm"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor={`${formIdPrefix}-boot-confirm`}
                  className="block text-xs font-semibold"
                >
                  パスワード（確認）
                </label>
                <input
                  id={`${formIdPrefix}-boot-confirm`}
                  data-testid="bootstrap-password-confirm-input"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirmPasswordInput}
                  onChange={(e) => setConfirmPasswordInput(e.target.value)}
                  placeholder="同じパスワードをもう一度入力"
                  className="min-h-[44px] w-full rounded-xl border px-3 text-sm"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                />
              </div>

              <button
                type="submit"
                data-testid="bootstrap-submit-btn"
                disabled={isSubmitting}
                className="inline-flex min-h-[48px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-ink)",
                }}
              >
                {isSubmitting ? "オーナーを作成中…" : "オーナーアカウントを作成してログイン"}
              </button>
            </form>

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
            <div className="font-bold">認可境界（BOT-02・単一オーナー）</div>
            <ul
              className="list-disc space-y-1.5 pl-4 leading-relaxed"
              style={{ color: "var(--ink-muted)" }}
            >
              <li>
                <code className="font-mono">OWNER_EMAIL</code> 一致かつユーザー 0
                件時のみ初回オーナー登録を許可
              </li>
              <li>
                登録完了と同時に単一 <code className="font-mono">workspaces</code>{" "}
                行を作成し、2人目の新規登録をサーバー側で永久遮断
              </li>
              <li>
                作成後は <code className="font-mono">@better-auth/passkey</code> （Face ID / Touch
                ID）で 1 タップサインイン可能
              </li>
            </ul>
          </aside>
        </div>
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
                  接続元 OAuth
                  クライアントが最新の再認証を要求しています。パスキーまたはパスワードでオーナー再サインインを完了してください。
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
                className="space-y-2 rounded-xl border p-3 text-xs"
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
                {statusCheckFailed ? (
                  <button
                    type="button"
                    data-testid="sign-in-retry-btn"
                    onClick={() => {
                      void loadAuthState();
                    }}
                    className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold"
                    style={{
                      borderColor: "var(--border-default)",
                      backgroundColor: "var(--surface-card)",
                      color: "var(--ink-primary)",
                    }}
                  >
                    再試行する
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-2.5">
              <button
                type="button"
                data-testid="passkey-sign-in-btn"
                disabled={isSubmitting}
                onClick={() => {
                  void handlePasskeySignIn();
                }}
                className="inline-flex min-h-[48px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-ink)",
                }}
              >
                {isSubmitting
                  ? "認証を確認中…"
                  : isAlreadySignedInReauth
                    ? "パスキーで再認証する（Face ID / Touch ID）"
                    : "パスキーでサインイン（Face ID / Touch ID）"}
              </button>
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                登録済みの iPhone / Mac / 1Password パスキーで 1
                タップ認証します。自由サインアップはサーバー側で永久遮断されています。
              </p>
            </div>

            <div
              className="space-y-3 rounded-xl border p-3"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-subtle)",
              }}
            >
              <button
                type="button"
                data-testid="toggle-password-signin-btn"
                aria-expanded={showPasswordForm}
                onClick={() => setShowPasswordForm((prev) => !prev)}
                className="flex min-h-[44px] min-w-[44px] w-full cursor-pointer items-center justify-between gap-2 text-left text-xs font-semibold"
                style={{ color: "var(--ink-primary)" }}
              >
                <span>メールアドレス ＋ パスワードでサインイン</span>
                <span aria-hidden="true" style={{ color: "var(--ink-muted)" }}>
                  {showPasswordForm ? "▲" : "▼"}
                </span>
              </button>

              {showPasswordForm ? (
                <form
                  data-testid="email-sign-in-form"
                  onSubmit={(event) => {
                    void handlePasswordSignIn(event);
                  }}
                  className="space-y-2.5 border-t pt-3"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <div className="space-y-1">
                    <label
                      htmlFor={`${formIdPrefix}-signin-email`}
                      className="block text-xs font-semibold"
                    >
                      メールアドレス
                    </label>
                    <input
                      id={`${formIdPrefix}-signin-email`}
                      data-testid="signin-email-input"
                      type="email"
                      required
                      autoComplete="username webauthn"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="owner@example.com"
                      className="min-h-[44px] w-full rounded-xl border px-3 text-sm"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor={`${formIdPrefix}-signin-password`}
                      className="block text-xs font-semibold"
                    >
                      パスワード
                    </label>
                    <input
                      id={`${formIdPrefix}-signin-password`}
                      data-testid="signin-password-input"
                      type="password"
                      required
                      autoComplete="current-password"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="••••••••••••"
                      className="min-h-[44px] w-full rounded-xl border px-3 text-sm"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    />
                  </div>
                  <button
                    type="submit"
                    data-testid="email-sign-in-submit-btn"
                    disabled={isSubmitting}
                    className="inline-flex min-h-[44px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl border px-4 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      borderColor: "var(--border-default)",
                      backgroundColor: "var(--surface-card)",
                      color: "var(--ink-primary)",
                    }}
                  >
                    {isSubmitting
                      ? "サインイン中…"
                      : isAlreadySignedInReauth
                        ? "パスワードで再認証する"
                        : "パスワードでサインイン"}
                  </button>
                </form>
              ) : null}
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
                <code className="font-mono">OWNER_EMAIL</code>{" "}
                一致時のみ単一オーナーアカウントを許可（2人目の登録を永久遮断）
              </li>
              <li>
                Passkey は <code className="font-mono">@better-auth/passkey</code>（WebAuthn / D1{" "}
                <code className="font-mono">passkey</code>）で検証
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
