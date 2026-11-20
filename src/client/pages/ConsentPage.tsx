import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import { type BotScope } from "@/domain";

import {
  fetchOAuthConsentContext,
  type OAuthConsentContextView,
  submitOAuthConsentDecision,
} from "../api/auth-client";
import { buildSignInRedirectPath, isSafeRedirectUrl } from "../router";

export interface ConsentPageProps {
  readonly search: string;
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

type ConsentViewState =
  "loading" | "normal" | "non_owner" | "revoked" | "approved" | "denied" | "error";

interface ScopeMeta {
  readonly id: BotScope;
  readonly title: string;
  readonly desc: string;
}

const SCOPE_META_LIST: readonly ScopeMeta[] = [
  {
    id: "tasks:read",
    title: "タスク・成果の閲覧",
    desc: "get_workspace_context / list_tasks / get_task / get_artifact",
  },
  {
    id: "tasks:write",
    title: "タスク作成・占有・結果記録",
    desc: "create_task / claim_task / renew_lease / update_task / record_result",
  },
  {
    id: "proposals:write",
    title: "判断カードの提案・差替",
    desc: "submit_proposal / supersede_proposal（binary / single / multi）",
  },
  {
    id: "decisions:read",
    title: "確定済み判断の取得",
    desc: "list_decision_results（status='finalized' のみ。5秒仮確定は非公開）",
  },
];

function extractOriginDisplay(context: OAuthConsentContextView | null): string {
  if (context === null) {
    return "—";
  }
  const candidate = context.clientUri ?? context.redirectUris[0] ?? "";
  if (candidate === "") {
    return "—";
  }
  try {
    return new URL(candidate).origin;
  } catch {
    return candidate;
  }
}

export function ConsentPage(props: ConsentPageProps): ReactElement {
  const { search, onNavigate } = props;

  const parsedQuery = useMemo(() => {
    const rawQuery = search.startsWith("?") ? search.slice(1) : search;
    const params = new URLSearchParams(rawQuery);
    return {
      rawQuery,
      clientId: params.get("client_id")?.trim() ?? "",
      scope: params.get("scope")?.trim() ?? null,
      sig: params.get("sig")?.trim() ?? "",
    };
  }, [search]);

  const [viewState, setViewState] = useState<ConsentViewState>("loading");
  const [context, setContext] = useState<OAuthConsentContextView | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<readonly BotScope[]>([]);
  const [message, setMessage] = useState<string>("");
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    let active = true;

    const loadContext = async (): Promise<void> => {
      if (parsedQuery.clientId === "" || parsedQuery.sig === "") {
        setViewState("error");
        setContext(null);
        setSelectedScopes([]);
        setMessage(
          "OAuth 認可パラメータ（client_id または署名 sig）が不足または期限切れです。接続元クライアントから認可フローをやり直してください。",
        );
        return;
      }

      setViewState("loading");
      const res = await fetchOAuthConsentContext(parsedQuery.clientId, parsedQuery.scope);
      if (!active) {
        return;
      }
      if (res.kind === "unauthenticated") {
        onNavigate(buildSignInRedirectPath(`/consent${search}`), { replace: true });
        return;
      }
      if (res.kind === "non_owner") {
        setViewState("non_owner");
        setMessage(res.message);
        return;
      }
      if (res.kind === "error") {
        setViewState("error");
        setMessage(res.message);
        return;
      }

      setContext(res.context);
      const initialScopes =
        res.context.existingStatus === "active" || res.context.existingStatus === "paused"
          ? res.context.requestedBotScopes.filter((s) => res.context.existingScopes.includes(s))
          : res.context.requestedBotScopes;
      setSelectedScopes(
        initialScopes.length > 0 ? initialScopes : [...res.context.requestedBotScopes],
      );

      if (res.context.existingStatus === "revoked") {
        setViewState("revoked");
        setMessage(
          "この OAuth クライアントは失効済（revoked）のためアクセス許可操作をブロックしています。",
        );
        return;
      }

      setViewState("normal");
      setMessage("OAuth 2.1 リクエスト検証済（RFC 9728/8414 + PKCE + oauth_client_id 照合済）");
    };

    void loadContext();
    return () => {
      active = false;
    };
  }, [onNavigate, parsedQuery.clientId, parsedQuery.scope, parsedQuery.sig, search]);

  const isActionBlocked =
    isSubmitting ||
    viewState === "revoked" ||
    viewState === "error" ||
    viewState === "non_owner" ||
    viewState === "loading" ||
    context === null;

  const canApprove = !isActionBlocked && selectedScopes.length > 0;
  const canDeny = !isActionBlocked;

  const toggleScope = useCallback(
    (scope: BotScope): void => {
      if (isActionBlocked) {
        return;
      }
      setSelectedScopes((prev) =>
        prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope],
      );
    },
    [isActionBlocked],
  );

  const handleDecision = useCallback(
    async (accept: boolean): Promise<void> => {
      if (accept && !canApprove) {
        return;
      }
      if (!accept && !canDeny) {
        return;
      }
      if (context === null) {
        return;
      }

      setIsSubmitting(true);
      const grantedScopeString = accept
        ? [...context.otherRequestedScopes, ...selectedScopes].join(" ")
        : undefined;

      const res = await submitOAuthConsentDecision({
        accept,
        ...(grantedScopeString !== undefined ? { scope: grantedScopeString } : {}),
        oauthQuery: parsedQuery.rawQuery,
      });

      setIsSubmitting(false);

      if (res.kind === "unauthenticated") {
        onNavigate(buildSignInRedirectPath(`/consent${search}`), { replace: true });
        return;
      }
      if (res.kind === "non_owner") {
        setViewState("non_owner");
        setMessage(res.message);
        return;
      }
      if (res.kind === "revoked") {
        setViewState("revoked");
        setMessage(res.message);
        return;
      }
      if (res.kind === "error") {
        setViewState("error");
        setMessage(res.message);
        return;
      }

      setRedirectUrl(res.url);
      if (accept) {
        // M2: Handle prompt=login redirect back to /sign-in without showing a false "approved" banner
        const isSignInReauth = ((): boolean => {
          try {
            const parsedUrl = new URL(res.url, window.location.origin);
            return parsedUrl.origin === window.location.origin && parsedUrl.pathname === "/sign-in";
          } catch {
            return false;
          }
        })();
        if (isSignInReauth) {
          onNavigate(buildSignInRedirectPath(`/consent${search}`), { replace: true });
          return;
        }
        setViewState("approved");
        setMessage("同意を確定し、D1 の bot_connections へ絞り込み済スコープを保存しました。");
      } else {
        setViewState("denied");
        setMessage("アクセスを拒否しました（access_denied・bot_connections 未作成）。");
      }
    },
    [canApprove, canDeny, context, onNavigate, parsedQuery.rawQuery, search, selectedScopes],
  );

  const visibleScopeMeta = useMemo(() => {
    if (context === null) {
      return SCOPE_META_LIST;
    }
    return SCOPE_META_LIST.filter((item) => context.requestedBotScopes.includes(item.id));
  }, [context]);

  const originDisplay = extractOriginDisplay(context);

  const previewJson = useMemo(
    () =>
      JSON.stringify(
        {
          oauth_client_id: context?.clientId ?? (parsedQuery.clientId || "—"),
          effective_scopes:
            viewState === "revoked" || viewState === "error" || viewState === "non_owner"
              ? []
              : selectedScopes,
          status:
            viewState === "revoked"
              ? "revoked"
              : viewState === "error" || viewState === "non_owner"
                ? "blocked"
                : "active",
        },
        null,
        2,
      ),
    [context?.clientId, parsedQuery.clientId, selectedScopes, viewState],
  );

  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-[1040px] flex-col justify-center px-3 py-5 sm:px-5 sm:py-8"
      data-testid="consent-page"
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
            <h1 className="truncate text-base font-bold tracking-tight">OAuth 2.1 MCP 接続同意</h1>
            <p className="truncate text-xs" style={{ color: "var(--ink-muted)" }}>
              D1 スコープ絞り込み・BOT-02 認可境界
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
          data-testid="consent-loading"
          className="mx-auto w-full max-w-lg space-y-4 rounded-2xl border p-5 bb-card-shadow"
          style={{
            borderColor: "var(--border-default)",
            backgroundColor: "var(--surface-card)",
          }}
        >
          <div
            className="h-6 w-48 rounded-lg"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          />
          <div
            className="h-16 w-full rounded-xl"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          />
          <div
            className="h-14 w-full rounded-xl"
            style={{ backgroundColor: "var(--surface-subtle)" }}
          />
          <p
            role="status"
            aria-live="polite"
            className="text-center text-xs"
            style={{ color: "var(--ink-muted)" }}
          >
            OAuth 2.1 クライアント情報と要求スコープを検証中…
          </p>
        </section>
      ) : viewState === "non_owner" ? (
        <section
          role="alert"
          data-testid="consent-non-owner"
          className="mx-auto w-full max-w-lg space-y-4 rounded-2xl border p-5 bb-card-shadow"
          style={{
            borderColor: "var(--tone-decline-border)",
            backgroundColor: "var(--surface-card)",
          }}
        >
          <div className="space-y-1.5">
            <span
              className="inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold"
              style={{
                borderColor: "var(--tone-decline-border)",
                backgroundColor: "var(--tone-decline-bg)",
                color: "var(--tone-decline)",
              }}
            >
              403 NOT_AUTHORIZED
            </span>
            <h2 className="text-base font-bold">オーナー以外の OAuth 同意はできません</h2>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              {message}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              data-testid="consent-approve-btn"
              disabled
              className="inline-flex min-h-[48px] min-w-[44px] cursor-not-allowed items-center justify-center rounded-xl border px-4 text-xs font-bold opacity-40"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-subtle)",
                color: "var(--ink-muted)",
              }}
            >
              オーナー以外の許可は不可
            </button>
            <button
              type="button"
              onClick={() => onNavigate(buildSignInRedirectPath(`/consent${search}`))}
              className="inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              オーナーアカウントでサインイン
            </button>
          </div>
        </section>
      ) : viewState === "approved" && context !== null ? (
        <section
          data-testid="consent-approved"
          className="mx-auto w-full max-w-lg space-y-4 rounded-2xl border p-5 bb-card-shadow"
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
              同意完了・D1 Upsert 済
            </span>
            <h2 className="text-base font-bold">{context.clientName} を接続しました</h2>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              認可コードを発行し、D1 の <code className="font-mono">bot_connections</code>{" "}
              へ絞り込み済スコープを保存しました。設定画面（/settings）からいつでも一時停止・即時失効できます。
            </p>
          </div>
          <pre
            className="overflow-x-auto rounded-xl border p-3 font-mono text-xs"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-subtle)",
            }}
          >
            {JSON.stringify(
              {
                channel_type: "mcp_oauth",
                display_name: context.clientName,
                oauth_client_id: context.clientId,
                scopes: selectedScopes,
                status: "active",
              },
              null,
              2,
            )}
          </pre>
          {redirectUrl !== null && isSafeRedirectUrl(redirectUrl) ? (
            <button
              type="button"
              data-testid="consent-redirect-btn"
              onClick={() => {
                window.location.assign(redirectUrl);
              }}
              className="inline-flex min-h-[48px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              接続元クライアントへ戻る
            </button>
          ) : null}
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
            <div className="min-w-0 space-y-0.5">
              <div className="text-xs" style={{ color: "var(--ink-muted)" }}>
                OAuth 2.1 MCP 接続同意
              </div>
              <h2 className="break-words text-base font-bold tracking-tight">
                {context !== null
                  ? `${context.clientName} へのアクセス許可`
                  : "OAuth 認可リクエスト"}
              </h2>
            </div>

            {viewState === "revoked" || viewState === "error" ? (
              <div
                role="alert"
                data-testid={
                  viewState === "revoked" ? "consent-revoked-alert" : "consent-error-alert"
                }
                className="space-y-1 rounded-xl border p-3 text-xs"
                style={{
                  borderColor: "var(--tone-decline-border)",
                  backgroundColor: "var(--tone-decline-bg)",
                }}
              >
                <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
                  {viewState === "revoked"
                    ? "NOT_AUTHORIZED / 接続失効済（revoked）"
                    : "OAuth リクエスト検証エラー"}
                </div>
                <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                  {message}
                </p>
              </div>
            ) : viewState === "denied" ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="consent-denied-banner"
                className="space-y-1 rounded-xl border p-3 text-xs"
                style={{
                  borderColor: "var(--tone-warn-border)",
                  backgroundColor: "var(--tone-warn-bg)",
                }}
              >
                <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                  アクセスを拒否しました（access_denied）
                </div>
                <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                  {message}
                </p>
                {redirectUrl !== null && isSafeRedirectUrl(redirectUrl) ? (
                  <button
                    type="button"
                    onClick={() => {
                      window.location.assign(redirectUrl);
                    }}
                    className="mt-2 inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold"
                    style={{
                      borderColor: "var(--border-default)",
                      backgroundColor: "var(--surface-card)",
                      color: "var(--ink-primary)",
                    }}
                  >
                    接続元クライアントへ戻る
                  </button>
                ) : null}
              </div>
            ) : null}

            <div
              className="space-y-1.5 rounded-xl border p-3 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--surface-subtle)",
              }}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="shrink-0" style={{ color: "var(--ink-muted)" }}>
                  Client ID
                </span>
                <span className="min-w-0 truncate font-mono">
                  {context?.clientId ?? (parsedQuery.clientId || "—")}
                </span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="shrink-0" style={{ color: "var(--ink-muted)" }}>
                  接続元
                </span>
                <span className="min-w-0 truncate font-mono">{originDisplay}</span>
              </div>
              {context?.existingStatus === "paused" ? (
                <div
                  data-testid="consent-reconsent-paused-notice"
                  className="pt-1 font-semibold"
                  style={{ color: "var(--tone-warn)" }}
                >
                  ※
                  現在一時停止中（paused）の接続です。許可すると選択スコープで再開（active）されます。
                </div>
              ) : context?.existingStatus === "active" ? (
                <div className="pt-1" style={{ color: "var(--ink-muted)" }}>
                  ※ 既存接続（active）の再同意です。許可すると選択スコープで D1 を更新します。
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-bold">
                D1 実効スコープ絞り込み（token.scopes ∩ bot_connections.scopes）
              </div>
              {visibleScopeMeta.map((scopeItem) => {
                const checked = selectedScopes.includes(scopeItem.id);
                return (
                  <button
                    key={scopeItem.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    data-testid={`consent-scope-${scopeItem.id}`}
                    disabled={isActionBlocked}
                    onClick={() => toggleScope(scopeItem.id)}
                    className="flex min-h-[48px] min-w-[44px] w-full cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                    style={{
                      borderColor: checked ? "var(--tone-accept-border)" : "var(--border-default)",
                      backgroundColor: checked ? "var(--tone-accept-bg)" : "var(--surface-card)",
                    }}
                  >
                    <span
                      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 text-xs font-bold"
                      style={{
                        borderColor: checked ? "var(--tone-accept)" : "var(--ink-muted)",
                        backgroundColor: checked ? "var(--tone-accept)" : "transparent",
                        color: "var(--accent-primary-ink)",
                      }}
                      aria-hidden="true"
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span className="min-w-0">
                      <span className="block break-words text-xs font-bold">
                        {scopeItem.title}{" "}
                        <span
                          className="font-mono font-normal"
                          style={{ color: "var(--ink-muted)" }}
                        >
                          ({scopeItem.id})
                        </span>
                      </span>
                      <span
                        className="block break-words text-xs"
                        style={{ color: "var(--ink-muted)" }}
                      >
                        {scopeItem.desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Explicit BOT-02 Prohibition Box */}
            <div
              data-testid="consent-bot02-prohibition"
              className="space-y-1 rounded-xl border p-3 text-xs"
              style={{
                borderColor: "var(--tone-warn-border)",
                backgroundColor: "var(--tone-warn-bg)",
              }}
            >
              <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                許可されない操作（BOT-02 強制）
              </div>
              <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                判断カードの採用・見送り・5秒取消・保留、タスク強制再開、および他の Bot 接続管理は
                MCP に公開されません。
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                data-testid="consent-deny-btn"
                disabled={!canDeny}
                onClick={() => {
                  void handleDecision(false);
                }}
                className="inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  borderColor: "var(--border-default)",
                  backgroundColor: "var(--surface-subtle)",
                  color: "var(--ink-primary)",
                }}
              >
                拒否する
              </button>
              <button
                type="button"
                data-testid="consent-approve-btn"
                disabled={!canApprove}
                onClick={() => {
                  void handleDecision(true);
                }}
                className="inline-flex min-h-[48px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-ink)",
                }}
              >
                {viewState === "revoked"
                  ? "失効済のため不可"
                  : viewState === "error"
                    ? "エラーのため不可"
                    : isSubmitting
                      ? "保存中…"
                      : selectedScopes.length > 0
                        ? `${selectedScopes.length}スコープで許可`
                        : "1つ以上選択"}
              </button>
            </div>
          </section>

          <aside
            className="space-y-3 rounded-2xl border p-4 text-xs lg:col-span-5"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div className="font-bold">毎リクエスト D1 照合プレビュー</div>
            <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              同意完了時に D1 の <code className="font-mono">bot_connections</code> を Upsert
              します。以後の <code className="font-mono">/api/mcp</code> 呼び出しは毎回{" "}
              <code className="font-mono">token.scopes ∩ bot_connections.scopes</code>{" "}
              を強制します。
            </p>
            <pre
              className="overflow-x-auto rounded-xl border p-2.5 font-mono text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                backgroundColor: "var(--surface-subtle)",
              }}
            >
              {previewJson}
            </pre>
            <div role="status" aria-live="polite" style={{ color: "var(--ink-muted)" }}>
              {message}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
