import { type ReactElement, useCallback, useEffect, useId, useState } from "react";

import { BOT_SCOPES, type BotScope, budgetLimitSchema, DomainError } from "@/domain";

import {
  deleteOwnerPasskey,
  listOwnerPasskeys,
  type OwnerPasskeyDto,
  registerOwnerPasskey,
  signOutOwner,
} from "../api/auth-client";
import { ClientAuthError, ClientTransportError } from "../api/decision-client";
import {
  createHumanWorkerBotApi,
  fetchHumanBots,
  fetchHumanWorkspace,
  generateClientRequestId,
  type HumanBotDto,
  type HumanWorkspaceDto,
  updateHumanBotApi,
  updateHumanWorkspaceApi,
} from "../api/human-api-client";
import { BottomNav, type NavTabId } from "../components/BottomNav";
import { buildSignInRedirectPath } from "../router";

export interface SettingsPageProps {
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

const EXTERNAL_CHANNEL_STATUS_LIST: ReadonlyArray<{
  readonly name: string;
  readonly route: string;
  readonly status: string;
}> = [
  { name: "ChatGPT Remote MCP", route: "mcp_oauth (#17)", status: "未実施（実機確認待）" },
  { name: "Claude Custom Connector", route: "mcp_oauth (#20)", status: "未実施（実機確認待）" },
  {
    name: "Meta Muse Custom Connector / Model API",
    route: "mcp_oauth / worker (#33)",
    status: "未実施（実機確認待）",
  },
  {
    name: "Google Gemini MCP / Gemini API",
    route: "mcp_oauth / worker (#34)",
    status: "未実施（実機確認待）",
  },
  { name: "Grok API Worker", route: "worker_bearer (#18)", status: "未実施（実機確認待）" },
];

function formatErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof DomainError || err instanceof ClientTransportError) {
    return err.message;
  }
  return fallback;
}

export function SettingsPage(props: SettingsPageProps): ReactElement {
  const { onNavigate } = props;

  const [workspace, setWorkspace] = useState<HumanWorkspaceDto | null>(null);
  const [bots, setBots] = useState<readonly HumanBotDto[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>(
    "ワークスペースの上限設定・緊急停止および Bot 接続の権限を管理できます。",
  );

  // Editable workspace fields
  const [goalInput, setGoalInput] = useState<string>("");
  const [scopeInput, setScopeInput] = useState<string>("");
  const [maxCardsInput, setMaxCardsInput] = useState<string>("20");
  const [maxStepsInput, setMaxStepsInput] = useState<string>("10");
  const [dailyCostUsdInput, setDailyCostUsdInput] = useState<string>("3.00");
  const [isSavingWorkspace, setIsSavingWorkspace] = useState<boolean>(false);

  // Worker Bearer issuance form
  const [showIssueForm, setShowIssueForm] = useState<boolean>(false);
  const [newBotName, setNewBotName] = useState<string>("Grok Worker");
  const [newBotScopes, setNewBotScopes] = useState<readonly BotScope[]>([...BOT_SCOPES]);
  const [isIssuingBot, setIsIssuingBot] = useState<boolean>(false);
  const [issuedBearerOnce, setIssuedBearerOnce] = useState<{
    readonly botName: string;
    readonly token: string;
  } | null>(null);

  // Per-bot mutation & 2-step revocation confirmation
  const [mutatingBotId, setMutatingBotId] = useState<string | null>(null);
  const [pendingRevokeBotId, setPendingRevokeBotId] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);
  const [copiedMcpUrl, setCopiedMcpUrl] = useState<boolean>(false);

  // Passkey management state
  const [passkeys, setPasskeys] = useState<readonly OwnerPasskeyDto[]>([]);
  const [passkeysLoadError, setPasskeysLoadError] = useState<string | null>(null);
  const [newPasskeyName, setNewPasskeyName] = useState<string>("");
  const [isRegisteringPasskey, setIsRegisteringPasskey] = useState<boolean>(false);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null);
  const [pendingDeletePasskeyId, setPendingDeletePasskeyId] = useState<string | null>(null);

  const formIdPrefix = useId();
  const mcpEndpointUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp";

  const handleAuthError = useCallback(
    (err: ClientAuthError): void => {
      onNavigate(
        err.status === 401 ? buildSignInRedirectPath("/settings") : "/sign-in?error=NOT_AUTHORIZED",
        { replace: true },
      );
    },
    [onNavigate],
  );

  const loadAll = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorBanner(null);
    setPasskeysLoadError(null);
    setPendingRevokeBotId(null);
    setPendingDeletePasskeyId(null);
    try {
      const [ws, botList, passkeyResult] = await Promise.all([
        fetchHumanWorkspace(),
        fetchHumanBots(),
        listOwnerPasskeys(),
      ]);
      setWorkspace(ws);
      setBots(botList);
      if (passkeyResult.ok) {
        setPasskeys(passkeyResult.passkeys);
        setPasskeysLoadError(null);
      } else if (passkeyResult.status === 401) {
        onNavigate(buildSignInRedirectPath("/settings"), { replace: true });
        return;
      } else if (passkeyResult.status === 403) {
        onNavigate("/sign-in?error=NOT_AUTHORIZED", { replace: true });
        return;
      } else {
        setPasskeys([]);
        setPasskeysLoadError(passkeyResult.message);
        setErrorBanner(passkeyResult.message);
      }
      setGoalInput(ws.goal);
      setScopeInput(ws.allowed_scope);
      setMaxCardsInput(String(ws.budget_limit.max_cards_per_day));
      setMaxStepsInput(String(ws.budget_limit.max_steps_per_task));
      setDailyCostUsdInput((ws.budget_limit.daily_cost_limit_cents / 100).toFixed(2));
    } catch (err) {
      if (err instanceof ClientAuthError) {
        handleAuthError(err);
        return;
      }
      setErrorBanner(formatErrorMessage(err, "設定の読み込みに失敗しました。"));
    } finally {
      setIsLoading(false);
    }
  }, [handleAuthError, onNavigate]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleToggleWorkspacePause = useCallback(async (): Promise<void> => {
    if (workspace === null || isSavingWorkspace) {
      return;
    }
    setIsSavingWorkspace(true);
    setErrorBanner(null);
    try {
      const nextPaused = !workspace.is_paused;
      const updated = await updateHumanWorkspaceApi({
        requestId: generateClientRequestId("ws-pause"),
        expectedVersion: workspace.version,
        isPaused: nextPaused,
      });
      setWorkspace(updated);
      setStatusMessage(
        nextPaused
          ? "緊急一時停止を有効にしました（全 Bot の書込・Worker を停止）。"
          : "緊急一時停止を解除しました。",
      );
    } catch (err) {
      if (err instanceof ClientAuthError) {
        handleAuthError(err);
        return;
      }
      setErrorBanner(formatErrorMessage(err, "緊急一時停止の切替に失敗しました。"));
    } finally {
      setIsSavingWorkspace(false);
    }
  }, [handleAuthError, isSavingWorkspace, workspace]);

  const handleSaveWorkspace = useCallback(async (): Promise<void> => {
    if (workspace === null || isSavingWorkspace) {
      return;
    }
    const trimmedCards = maxCardsInput.trim();
    const trimmedSteps = maxStepsInput.trim();
    const trimmedUsd = dailyCostUsdInput.trim();
    if (trimmedCards === "" || trimmedSteps === "" || trimmedUsd === "") {
      setErrorBanner(
        "上限値は空欄にできません（カード/日: 1〜1000の整数、ステップ/Task: 1〜200の整数、費用上限: $0.00〜$10000.00）。",
      );
      return;
    }
    const parsedCards = Number(trimmedCards);
    const parsedSteps = Number(trimmedSteps);
    const parsedUsd = Number(trimmedUsd);
    const budgetCheck = budgetLimitSchema.safeParse({
      max_cards_per_day: Math.trunc(parsedCards),
      max_steps_per_task: Math.trunc(parsedSteps),
      daily_cost_limit_cents: Math.round(parsedUsd * 100),
    });
    if (
      !Number.isFinite(parsedCards) ||
      !Number.isFinite(parsedSteps) ||
      !Number.isFinite(parsedUsd) ||
      !Number.isInteger(parsedCards) ||
      !Number.isInteger(parsedSteps) ||
      parsedUsd < 0 ||
      !budgetCheck.success
    ) {
      setErrorBanner(
        "上限値が不正です（カード/日: 1〜1000の整数、ステップ/Task: 1〜200の整数、費用上限: $0.00〜$10000.00）。",
      );
      return;
    }

    setIsSavingWorkspace(true);
    setErrorBanner(null);
    try {
      const updated = await updateHumanWorkspaceApi({
        requestId: generateClientRequestId("ws-save"),
        expectedVersion: workspace.version,
        goal: goalInput.trim(),
        allowedScope: scopeInput.trim(),
        budgetLimit: budgetCheck.data,
      });
      setWorkspace(updated);
      setGoalInput(updated.goal);
      setScopeInput(updated.allowed_scope);
      setMaxCardsInput(String(updated.budget_limit.max_cards_per_day));
      setMaxStepsInput(String(updated.budget_limit.max_steps_per_task));
      setDailyCostUsdInput((updated.budget_limit.daily_cost_limit_cents / 100).toFixed(2));
      setStatusMessage(`ワークスペース設定を保存しました（v${updated.version}）。`);
    } catch (err) {
      if (err instanceof ClientAuthError) {
        handleAuthError(err);
        return;
      }
      setErrorBanner(formatErrorMessage(err, "ワークスペース設定の保存に失敗しました。"));
    } finally {
      setIsSavingWorkspace(false);
    }
  }, [
    dailyCostUsdInput,
    goalInput,
    handleAuthError,
    isSavingWorkspace,
    maxCardsInput,
    maxStepsInput,
    scopeInput,
    workspace,
  ]);

  const handleToggleNewBotScope = useCallback((scope: BotScope): void => {
    setNewBotScopes((prev) =>
      prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope],
    );
  }, []);

  const handleIssueWorkerBot = useCallback(async (): Promise<void> => {
    if (isIssuingBot) {
      return;
    }
    const trimmedName = newBotName.trim();
    if (trimmedName === "" || newBotScopes.length === 0) {
      setErrorBanner("表示名と 1 つ以上のスコープを指定してください。");
      return;
    }

    setIsIssuingBot(true);
    setErrorBanner(null);
    try {
      const created = await createHumanWorkerBotApi({
        requestId: generateClientRequestId("bot-create"),
        displayName: trimmedName,
        scopes: newBotScopes,
      });
      if (created.bearer_token !== null) {
        setIssuedBearerOnce({
          botName: created.display_name,
          token: created.bearer_token,
        });
      }
      setShowIssueForm(false);
      setStatusMessage(`Worker Bot「${created.display_name}」を発行しました。`);
      const refreshedBots = await fetchHumanBots();
      setBots(refreshedBots);
    } catch (err) {
      if (err instanceof ClientAuthError) {
        handleAuthError(err);
        return;
      }
      setErrorBanner(formatErrorMessage(err, "Worker Bearer の発行に失敗しました。"));
    } finally {
      setIsIssuingBot(false);
    }
  }, [handleAuthError, isIssuingBot, newBotName, newBotScopes]);

  const handleToggleBotScope = useCallback(
    async (bot: HumanBotDto, scope: BotScope): Promise<void> => {
      if (mutatingBotId !== null || bot.status === "revoked") {
        return;
      }
      const nextScopes = bot.scopes.includes(scope)
        ? bot.scopes.filter((s) => s !== scope)
        : [...bot.scopes, scope];
      if (nextScopes.length === 0) {
        setErrorBanner(
          "最低 1 つのスコープが必要です。接続を止める場合は一時停止または失効を使用してください。",
        );
        return;
      }

      setMutatingBotId(bot.id);
      setErrorBanner(null);
      try {
        const updated = await updateHumanBotApi(bot.id, {
          requestId: generateClientRequestId("bot-scope"),
          expectedVersion: bot.version,
          scopes: nextScopes,
        });
        setBots((prev) =>
          prev.map((item) =>
            item.id === bot.id
              ? { ...item, scopes: updated.scopes, version: updated.version }
              : item,
          ),
        );
        setStatusMessage(
          `「${bot.display_name}」のスコープを更新しました（v${updated.version}）。`,
        );
      } catch (err) {
        if (err instanceof ClientAuthError) {
          handleAuthError(err);
          return;
        }
        setErrorBanner(formatErrorMessage(err, "Bot スコープの更新に失敗しました。"));
      } finally {
        setMutatingBotId(null);
      }
    },
    [handleAuthError, mutatingBotId],
  );

  const handleToggleBotPause = useCallback(
    async (bot: HumanBotDto): Promise<void> => {
      if (mutatingBotId !== null || bot.status === "revoked") {
        return;
      }
      const nextStatus = bot.status === "paused" ? "active" : "paused";
      setMutatingBotId(bot.id);
      setErrorBanner(null);
      try {
        const updated = await updateHumanBotApi(bot.id, {
          requestId: generateClientRequestId("bot-pause"),
          expectedVersion: bot.version,
          status: nextStatus,
        });
        setBots((prev) =>
          prev.map((item) =>
            item.id === bot.id
              ? { ...item, status: updated.status, version: updated.version }
              : item,
          ),
        );
        setStatusMessage(
          `「${bot.display_name}」を ${updated.status} に変更しました（次回リクエストから D1 照合で即時反映）。`,
        );
      } catch (err) {
        if (err instanceof ClientAuthError) {
          handleAuthError(err);
          return;
        }
        setErrorBanner(formatErrorMessage(err, "Bot 状態の更新に失敗しました。"));
      } finally {
        setMutatingBotId(null);
      }
    },
    [handleAuthError, mutatingBotId],
  );

  const handleConfirmRevokeBot = useCallback(
    async (bot: HumanBotDto): Promise<void> => {
      if (mutatingBotId !== null || bot.status === "revoked") {
        return;
      }
      setMutatingBotId(bot.id);
      setErrorBanner(null);
      try {
        const updated = await updateHumanBotApi(bot.id, {
          requestId: generateClientRequestId("bot-revoke"),
          expectedVersion: bot.version,
          status: "revoked",
        });
        setBots((prev) =>
          prev.map((item) =>
            item.id === bot.id
              ? { ...item, status: updated.status, version: updated.version }
              : item,
          ),
        );
        setPendingRevokeBotId(null);
        setStatusMessage(
          `「${bot.display_name}」を即時失効（revoked）しました。保有 WorkLease と OAuth トークン/同意を同一バッチで失効済みです。`,
        );
      } catch (err) {
        if (err instanceof ClientAuthError) {
          handleAuthError(err);
          return;
        }
        setErrorBanner(formatErrorMessage(err, "Bot の失効に失敗しました。"));
      } finally {
        setMutatingBotId(null);
      }
    },
    [handleAuthError, mutatingBotId],
  );

  const handleSignOut = useCallback(async (): Promise<void> => {
    if (isSigningOut) {
      return;
    }
    setIsSigningOut(true);
    setErrorBanner(null);
    const res = await signOutOwner();
    setIsSigningOut(false);
    if (!res.ok) {
      setErrorBanner(res.message);
      return;
    }
    onNavigate("/sign-in", { replace: true });
  }, [isSigningOut, onNavigate]);

  const handleCopyMcpUrl = useCallback(async (): Promise<void> => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(mcpEndpointUrl);
        setCopiedMcpUrl(true);
        setStatusMessage(`Remote MCP エンドポイント URL をコピーしました: ${mcpEndpointUrl}`);
        return;
      }
      setStatusMessage(`クリップボード未対応のため手動でコピーしてください: ${mcpEndpointUrl}`);
    } catch {
      setStatusMessage(`コピーに失敗しました。手動でコピーしてください: ${mcpEndpointUrl}`);
    }
  }, [mcpEndpointUrl]);

  const handleRegisterPasskey = useCallback(async (): Promise<void> => {
    if (isRegisteringPasskey) {
      return;
    }
    setIsRegisteringPasskey(true);
    setErrorBanner(null);
    const trimmedName = newPasskeyName.trim();
    const res = await registerOwnerPasskey(trimmedName !== "" ? trimmedName : undefined);
    setIsRegisteringPasskey(false);
    if (!res.ok) {
      if (res.status === 401) {
        onNavigate(buildSignInRedirectPath("/settings"), { replace: true });
        return;
      }
      setErrorBanner(res.message);
      return;
    }
    setNewPasskeyName("");
    const refreshed = await listOwnerPasskeys();
    if (refreshed.ok) {
      setPasskeys(refreshed.passkeys);
      setPasskeysLoadError(null);
    } else if (res.passkey !== undefined) {
      const createdPasskey = res.passkey;
      setPasskeys((prev) => [...prev, createdPasskey]);
    }
    setStatusMessage(
      `パスキー${trimmedName !== "" ? `「${trimmedName}」` : ""}を登録しました。次回から 1 タップでサインインできます。`,
    );
  }, [isRegisteringPasskey, newPasskeyName, onNavigate]);

  const handleConfirmDeletePasskey = useCallback(
    async (pk: OwnerPasskeyDto): Promise<void> => {
      if (deletingPasskeyId !== null) {
        return;
      }
      setDeletingPasskeyId(pk.id);
      setErrorBanner(null);
      const res = await deleteOwnerPasskey(pk.id);
      setDeletingPasskeyId(null);
      if (!res.ok) {
        if (res.status === 401) {
          onNavigate(buildSignInRedirectPath("/settings"), { replace: true });
          return;
        }
        setErrorBanner(res.message);
        return;
      }
      setPendingDeletePasskeyId(null);
      setPasskeys((prev) => prev.filter((item) => item.id !== pk.id));
      setStatusMessage(`パスキー「${pk.name ?? "登録済みパスキー"}」を削除しました。`);
    },
    [deletingPasskeyId, onNavigate],
  );

  const handleSelectNav = useCallback(
    (tab: NavTabId): void => {
      onNavigate(tab === "decide" ? "/" : `/${tab}`);
    },
    [onNavigate],
  );

  const showOnboarding = workspace !== null && (workspace.goal.trim() === "" || bots.length === 0);

  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col justify-between px-3 py-4 sm:px-5 sm:py-6"
      data-testid="settings-page"
    >
      <div className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight">ワークスペース設定・Bot 接続管理</h1>
            <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
              構造化上限・緊急一時停止・スコープ編集・2段階確認付き即時失効を管理します。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void loadAll();
              }}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
                color: "var(--ink-primary)",
              }}
            >
              再読み込み
            </button>
            <button
              type="button"
              data-testid="btn-settings-sign-out"
              disabled={isSigningOut}
              onClick={() => {
                void handleSignOut();
              }}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-45"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-subtle)",
                color: "var(--ink-primary)",
              }}
            >
              {isSigningOut ? "終了中…" : "サインアウト"}
            </button>
          </div>
        </header>

        {workspace?.is_paused === true ? (
          <div
            role="alert"
            data-testid="settings-paused-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-xs"
            style={{
              borderColor: "var(--tone-decline-border)",
              backgroundColor: "var(--tone-decline-bg)",
            }}
          >
            <div className="min-w-0">
              <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
                WORKSPACE_PAUSED: 緊急一時停止中
              </div>
              <div style={{ color: "var(--ink-muted)" }}>
                全 Bot の新規占有・書込および Queue ワーカー起動を停止中です。
              </div>
            </div>
            <button
              type="button"
              disabled={isSavingWorkspace}
              onClick={() => {
                void handleToggleWorkspacePause();
              }}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-3 font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              停止を解除
            </button>
          </div>
        ) : null}

        {errorBanner !== null ? (
          <div
            role="alert"
            data-testid="settings-error-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-xs"
            style={{
              borderColor: "var(--tone-warn-border)",
              backgroundColor: "var(--tone-warn-bg)",
            }}
          >
            <div className="min-w-0 space-y-0.5">
              <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                入力検証・通信エラー
              </div>
              <div style={{ color: "var(--ink-muted)" }}>{errorBanner}</div>
            </div>
            <button
              type="button"
              data-testid="btn-settings-error-reload"
              disabled={isLoading}
              onClick={() => {
                void loadAll();
              }}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold disabled:opacity-45"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
                color: "var(--ink-primary)",
              }}
            >
              最新を再取得
            </button>
          </div>
        ) : null}

        {showOnboarding ? (
          <section
            data-testid="settings-onboarding"
            className="space-y-1 rounded-2xl border p-3.5 text-xs"
            style={{
              borderColor: "var(--tone-info-border)",
              backgroundColor: "var(--tone-info-bg)",
            }}
          >
            <div className="font-bold">初回オンボーディング（UX-01 準備）</div>
            <p className="leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              ① 下の目的・事前許可範囲・1日上限を保存 → ② 右の「+ Worker Bearer 発行」または OAuth
              同意（/consent）で最初の Bot を接続してください。
            </p>
          </section>
        ) : null}

        {isLoading && workspace === null ? (
          <section
            aria-busy="true"
            data-testid="settings-loading"
            className="space-y-3 rounded-2xl border p-4"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div
              className="h-24 w-full rounded-xl"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
            <div
              className="h-24 w-full rounded-xl"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
          </section>
        ) : workspace !== null ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
            {/* Workspace Policy & Structured Budget Limits */}
            <section
              className="space-y-3 rounded-2xl border p-4 text-xs bb-card-shadow lg:col-span-5"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold">ワークスペース設定・緊急停止</h2>
                <span className="font-mono" style={{ color: "var(--ink-muted)" }}>
                  v{workspace.version}
                </span>
              </div>

              <div
                className="flex items-center justify-between gap-2 rounded-xl border p-3"
                style={{
                  borderColor: "var(--border-subtle)",
                  backgroundColor: "var(--surface-subtle)",
                }}
              >
                <div className="min-w-0">
                  <div className="font-bold">緊急一時停止（is_paused）</div>
                  <div style={{ color: "var(--ink-muted)" }}>
                    全 Bot の書込・新規占有・Worker を即時停止
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="btn-toggle-workspace-pause"
                  aria-pressed={workspace.is_paused}
                  disabled={isSavingWorkspace}
                  onClick={() => {
                    void handleToggleWorkspacePause();
                  }}
                  className="inline-flex min-h-[44px] min-w-[76px] shrink-0 cursor-pointer items-center justify-center rounded-xl px-3 font-bold disabled:opacity-45"
                  style={{
                    backgroundColor: workspace.is_paused
                      ? "var(--tone-decline)"
                      : "var(--accent-primary)",
                    color: "var(--accent-primary-ink)",
                  }}
                >
                  {workspace.is_paused ? "停止中" : "稼働中"}
                </button>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor={`${formIdPrefix}-goal`}
                  className="block font-semibold"
                  style={{ color: "var(--ink-muted)" }}
                >
                  目的（goal）
                </label>
                <textarea
                  id={`${formIdPrefix}-goal`}
                  data-testid="input-workspace-goal"
                  rows={2}
                  maxLength={2000}
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                  placeholder="例: 個人開発アプリ bot-board の競合調査と MVP 実装を進める"
                  className="w-full rounded-xl border p-2.5 text-xs"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor={`${formIdPrefix}-scope`}
                  className="block font-semibold"
                  style={{ color: "var(--ink-muted)" }}
                >
                  事前許可範囲（allowed_scope）
                </label>
                <input
                  id={`${formIdPrefix}-scope`}
                  data-testid="input-workspace-scope"
                  type="text"
                  maxLength={2000}
                  value={scopeInput}
                  onChange={(e) => setScopeInput(e.target.value)}
                  placeholder="例: タスク分解・調査・設計下書き（外部公開/課金は禁止）"
                  className="min-h-[44px] w-full rounded-xl border px-3 text-xs"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                />
              </div>

              <fieldset
                className="space-y-2 rounded-xl border p-3"
                style={{
                  borderColor: "var(--border-subtle)",
                  backgroundColor: "var(--surface-subtle)",
                }}
              >
                <legend className="px-1 font-bold">機械強制上限（budget_limit JSON）</legend>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label
                      htmlFor={`${formIdPrefix}-cards`}
                      className="block"
                      style={{ color: "var(--ink-muted)" }}
                    >
                      カード/日
                    </label>
                    <input
                      id={`${formIdPrefix}-cards`}
                      data-testid="input-budget-cards"
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      value={maxCardsInput}
                      onChange={(e) => setMaxCardsInput(e.target.value)}
                      className="mt-1 min-h-[44px] w-full rounded-lg border px-2 font-mono text-xs"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`${formIdPrefix}-steps`}
                      className="block"
                      style={{ color: "var(--ink-muted)" }}
                    >
                      ステップ/Task
                    </label>
                    <input
                      id={`${formIdPrefix}-steps`}
                      data-testid="input-budget-steps"
                      type="number"
                      min={1}
                      max={200}
                      step={1}
                      value={maxStepsInput}
                      onChange={(e) => setMaxStepsInput(e.target.value)}
                      className="mt-1 min-h-[44px] w-full rounded-lg border px-2 font-mono text-xs"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`${formIdPrefix}-cost`}
                      className="block"
                      style={{ color: "var(--ink-muted)" }}
                    >
                      費用上限($)
                    </label>
                    <input
                      id={`${formIdPrefix}-cost`}
                      data-testid="input-budget-cost"
                      type="number"
                      min={0}
                      max={10000}
                      step={0.5}
                      value={dailyCostUsdInput}
                      onChange={(e) => setDailyCostUsdInput(e.target.value)}
                      className="mt-1 min-h-[44px] w-full rounded-lg border px-2 font-mono text-xs"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    />
                  </div>
                </div>
              </fieldset>

              <button
                type="button"
                data-testid="btn-save-workspace"
                disabled={isSavingWorkspace}
                onClick={() => {
                  void handleSaveWorkspace();
                }}
                className="inline-flex min-h-[44px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-4 font-bold disabled:opacity-45"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-ink)",
                }}
              >
                {isSavingWorkspace ? "保存中…" : "設定を保存（PATCH /api/human/workspace）"}
              </button>
            </section>

            {/* Bot Connections Management */}
            <section
              className="space-y-3 rounded-2xl border p-4 text-xs bb-card-shadow lg:col-span-7"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold">Bot 接続管理（bot_connections）</h2>
                  <p style={{ color: "var(--ink-muted)" }}>
                    スコープ変更・一時停止・2段階確認付き即時失効を操作できます。
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="btn-open-issue-worker"
                  aria-expanded={showIssueForm}
                  onClick={() => setShowIssueForm((prev) => !prev)}
                  className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                >
                  {showIssueForm ? "発行フォームを閉じる" : "+ Worker Bearer 発行"}
                </button>
              </div>

              <div
                data-testid="settings-mcp-endpoint-box"
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3"
                style={{
                  borderColor: "var(--border-subtle)",
                  backgroundColor: "var(--surface-subtle)",
                }}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-bold">Remote MCP エンドポイント URL（OAuth 2.1）</div>
                  <code
                    data-testid="settings-mcp-endpoint-url"
                    className="block truncate font-mono text-xs"
                    style={{ color: "var(--ink-muted)" }}
                  >
                    {mcpEndpointUrl}
                  </code>
                </div>
                <button
                  type="button"
                  data-testid="btn-copy-mcp-url"
                  onClick={() => {
                    void handleCopyMcpUrl();
                  }}
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-card)",
                    color: "var(--ink-primary)",
                  }}
                >
                  {copiedMcpUrl ? "コピー済" : "URL をコピー"}
                </button>
              </div>

              {showIssueForm ? (
                <div
                  data-testid="issue-worker-form"
                  className="space-y-2.5 rounded-xl border p-3"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                  }}
                >
                  <div className="font-bold">新規 Worker Bearer 発行（POST /api/human/bots）</div>
                  <div>
                    <label
                      htmlFor={`${formIdPrefix}-bot-name`}
                      className="block"
                      style={{ color: "var(--ink-muted)" }}
                    >
                      表示名（display_name）
                    </label>
                    <input
                      id={`${formIdPrefix}-bot-name`}
                      data-testid="input-new-bot-name"
                      type="text"
                      maxLength={120}
                      value={newBotName}
                      onChange={(e) => setNewBotName(e.target.value)}
                      className="mt-1 min-h-[44px] w-full rounded-xl border px-3 text-xs"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {BOT_SCOPES.map((sc) => {
                      const checked = newBotScopes.includes(sc);
                      return (
                        <button
                          key={sc}
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          data-testid={`new-bot-scope-${sc}`}
                          onClick={() => handleToggleNewBotScope(sc)}
                          className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border px-2.5 font-mono"
                          style={{
                            borderColor: checked
                              ? "var(--tone-accept-border)"
                              : "var(--border-default)",
                            backgroundColor: checked ? "var(--tone-accept-bg)" : "transparent",
                          }}
                        >
                          {checked ? "✓ " : ""}
                          {sc}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    data-testid="btn-submit-issue-worker"
                    disabled={isIssuingBot || newBotScopes.length === 0 || newBotName.trim() === ""}
                    onClick={() => {
                      void handleIssueWorkerBot();
                    }}
                    className="inline-flex min-h-[44px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-3 font-bold disabled:opacity-45"
                    style={{
                      backgroundColor: "var(--accent-primary)",
                      color: "var(--accent-primary-ink)",
                    }}
                  >
                    {isIssuingBot ? "発行中…" : "トークンを発行して追加する"}
                  </button>
                </div>
              ) : null}

              {issuedBearerOnce !== null ? (
                <div
                  data-testid="issued-bearer-banner"
                  className="space-y-1.5 rounded-xl border p-3"
                  style={{
                    borderColor: "var(--tone-warn-border)",
                    backgroundColor: "var(--tone-warn-bg)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      role="status"
                      aria-live="polite"
                      className="font-bold"
                      style={{ color: "var(--tone-warn)" }}
                    >
                      1回限り表示（{issuedBearerOnce.botName}・平文は再表示不可）
                    </span>
                    <button
                      type="button"
                      onClick={() => setIssuedBearerOnce(null)}
                      className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border px-2.5 font-semibold"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                        color: "var(--ink-primary)",
                      }}
                    >
                      閉じる
                    </button>
                  </div>
                  <div className="break-all font-mono">{issuedBearerOnce.token}</div>
                </div>
              ) : null}

              {bots.length === 0 ? (
                <div
                  data-testid="settings-bots-empty"
                  className="rounded-xl border p-4 text-center"
                  style={{
                    borderColor: "var(--border-subtle)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-muted)",
                  }}
                >
                  接続済みの Bot は 0 件です。上の「+ Worker Bearer 発行」または OAuth
                  同意（/consent）で接続してください。
                </div>
              ) : (
                <div className="space-y-2.5" data-testid="settings-bots-list">
                  {bots.map((bot) => {
                    const isRevoked = bot.status === "revoked";
                    const isConfirmingRevoke = pendingRevokeBotId === bot.id;
                    const isMutating = mutatingBotId === bot.id;
                    return (
                      <article
                        key={bot.id}
                        data-testid={`settings-bot-${bot.id}`}
                        className="space-y-2.5 rounded-xl border p-3"
                        style={{
                          borderColor: "var(--border-subtle)",
                          backgroundColor: "var(--surface-subtle)",
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="break-words text-sm font-bold">{bot.display_name}</div>
                            <div style={{ color: "var(--ink-muted)" }}>
                              種別: <span className="font-mono">{bot.channel_type}</span> ・ v
                              {bot.version}
                            </div>
                          </div>
                          <span
                            data-testid={`settings-bot-status-${bot.id}`}
                            className="rounded-full border px-2.5 py-0.5 font-mono font-semibold"
                            style={{
                              borderColor: "var(--border-default)",
                              backgroundColor: "var(--surface-card)",
                            }}
                          >
                            {bot.status}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div style={{ color: "var(--ink-muted)" }}>
                            実効スコープ編集（タップで切替・即時 D1 反映）:
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {BOT_SCOPES.map((sc) => {
                              const has = bot.scopes.includes(sc);
                              return (
                                <button
                                  key={sc}
                                  type="button"
                                  role="checkbox"
                                  aria-checked={has}
                                  data-testid={`bot-scope-${bot.id}-${sc}`}
                                  disabled={isRevoked || isMutating}
                                  onClick={() => {
                                    void handleToggleBotScope(bot, sc);
                                  }}
                                  className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-lg border px-2.5 font-mono disabled:cursor-not-allowed disabled:opacity-40"
                                  style={{
                                    borderColor: has
                                      ? "var(--tone-accept-border)"
                                      : "var(--border-default)",
                                    backgroundColor: has
                                      ? "var(--tone-accept-bg)"
                                      : "var(--surface-card)",
                                  }}
                                >
                                  {has ? "✓ " : ""}
                                  {sc}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {isConfirmingRevoke && !isRevoked ? (
                          <div
                            role="alert"
                            data-testid={`revoke-confirm-box-${bot.id}`}
                            className="space-y-2 rounded-xl border p-2.5"
                            style={{
                              borderColor: "var(--tone-decline-border)",
                              backgroundColor: "var(--tone-decline-bg)",
                            }}
                          >
                            <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
                              本当に即時失効しますか？（取り消し不可）
                            </div>
                            <div style={{ color: "var(--ink-muted)" }}>
                              保有中の WorkLease と OAuth
                              トークン/同意を同一バッチで即座に失効します。
                            </div>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                data-testid={`btn-cancel-revoke-${bot.id}`}
                                disabled={isMutating}
                                onClick={() => setPendingRevokeBotId(null)}
                                className="inline-flex min-h-[44px] min-w-[44px] flex-1 cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
                                style={{
                                  borderColor: "var(--border-default)",
                                  backgroundColor: "var(--surface-card)",
                                  color: "var(--ink-primary)",
                                }}
                              >
                                キャンセル
                              </button>
                              <button
                                type="button"
                                data-testid={`btn-confirm-revoke-${bot.id}`}
                                disabled={isMutating}
                                onClick={() => {
                                  void handleConfirmRevokeBot(bot);
                                }}
                                className="inline-flex min-h-[44px] min-w-[44px] flex-1 cursor-pointer items-center justify-center rounded-xl px-3 font-bold"
                                style={{
                                  backgroundColor: "var(--tone-decline)",
                                  color: "var(--accent-primary-ink)",
                                }}
                              >
                                {isMutating ? "失効中…" : "失効を実行"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <button
                              type="button"
                              data-testid={`btn-pause-bot-${bot.id}`}
                              disabled={isRevoked || isMutating}
                              onClick={() => {
                                void handleToggleBotPause(bot);
                              }}
                              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                              style={{
                                borderColor: "var(--border-default)",
                                backgroundColor: "var(--surface-card)",
                                color: "var(--ink-primary)",
                              }}
                            >
                              {bot.status === "paused" ? "再開する (active)" : "一時停止 (paused)"}
                            </button>
                            <button
                              type="button"
                              data-testid={`btn-request-revoke-${bot.id}`}
                              disabled={isRevoked || isMutating}
                              onClick={() => setPendingRevokeBotId(bot.id)}
                              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                              style={{
                                borderColor: "var(--tone-decline-border)",
                                backgroundColor: "var(--surface-card)",
                                color: "var(--tone-decline)",
                              }}
                            >
                              {isRevoked ? "失効済 (revoked)" : "即時失効 (revoked)"}
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              {/* Honest External Bot Verification Status Matrix (never claims unverified channels as supported) */}
              <div
                className="space-y-1.5 rounded-xl border p-3"
                style={{
                  borderColor: "var(--border-subtle)",
                  backgroundColor: "var(--surface-subtle)",
                }}
              >
                <div className="font-bold">外部 Bot 実機実証ステータス（誠実表示）</div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {EXTERNAL_CHANNEL_STATUS_LIST.map((ch) => (
                    <div
                      key={ch.name}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                      }}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{ch.name}</div>
                        <div
                          className="truncate font-mono text-[11px]"
                          style={{ color: "var(--ink-muted)" }}
                        >
                          {ch.route}
                        </div>
                      </div>
                      <span
                        className="shrink-0 font-semibold"
                        style={{ color: "var(--ink-muted)" }}
                      >
                        {ch.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Owner Passkey Management (Face ID / Touch ID / 1Password) */}
            <section
              data-testid="settings-passkeys-section"
              className="space-y-3 rounded-2xl border p-4 text-xs bb-card-shadow lg:col-span-12"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold">パスキー管理（Face ID / Touch ID）</h2>
                  <p style={{ color: "var(--ink-muted)" }}>
                    登録済みパスキーを使うと、スマホ・PC からパスワード入力なしで 1
                    タップサインインできます。
                  </p>
                </div>
                <span
                  data-testid="passkey-count-badge"
                  className="shrink-0 rounded-full border px-2.5 py-0.5 font-semibold"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-primary)",
                  }}
                >
                  {passkeysLoadError !== null ? "取得失敗" : `${passkeys.length} 件登録済`}
                </span>
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleRegisterPasskey();
                }}
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <label
                    htmlFor={`${formIdPrefix}-passkey-name`}
                    className="block font-semibold"
                    style={{ color: "var(--ink-muted)" }}
                  >
                    端末名（任意）
                  </label>
                  <input
                    id={`${formIdPrefix}-passkey-name`}
                    data-testid="input-passkey-name"
                    type="text"
                    maxLength={80}
                    value={newPasskeyName}
                    onChange={(e) => setNewPasskeyName(e.target.value)}
                    placeholder="例: iPhone (Face ID) / MacBook (Touch ID)"
                    className="min-h-[44px] w-full rounded-xl border px-3 text-xs"
                    style={{
                      borderColor: "var(--border-default)",
                      backgroundColor: "var(--surface-subtle)",
                      color: "var(--ink-primary)",
                    }}
                  />
                </div>
                <button
                  type="submit"
                  data-testid="btn-register-passkey"
                  disabled={isRegisteringPasskey}
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl px-4 font-bold disabled:cursor-not-allowed disabled:opacity-45"
                  style={{
                    backgroundColor: "var(--accent-primary)",
                    color: "var(--accent-primary-ink)",
                  }}
                >
                  {isRegisteringPasskey ? "登録中…" : "+ パスキーを登録"}
                </button>
              </form>

              {passkeysLoadError !== null ? (
                <div
                  role="alert"
                  data-testid="settings-passkeys-error"
                  className="rounded-xl border p-3 text-xs"
                  style={{
                    borderColor: "var(--tone-warn-border)",
                    backgroundColor: "var(--tone-warn-bg)",
                    color: "var(--ink-primary)",
                  }}
                >
                  <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                    パスキー一覧の取得に失敗しました
                  </div>
                  <div style={{ color: "var(--ink-muted)" }}>{passkeysLoadError}</div>
                </div>
              ) : passkeys.length === 0 ? (
                <div
                  data-testid="settings-passkeys-empty"
                  className="rounded-xl border p-4 text-center"
                  style={{
                    borderColor: "var(--border-subtle)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--ink-muted)",
                  }}
                >
                  まだパスキーが登録されていません。上の「+
                  パスキーを登録」から現在の端末を追加できます。
                </div>
              ) : (
                <div className="space-y-2" data-testid="settings-passkeys-list">
                  {passkeys.map((pk) => {
                    const isConfirmingDelete = pendingDeletePasskeyId === pk.id;
                    const isDeleting = deletingPasskeyId === pk.id;
                    const label = pk.name?.trim() || "登録済みパスキー";
                    const deviceLabel =
                      pk.deviceType === "multiDevice" ? "同期パスキー" : "端末固有パスキー";
                    const createdDate = pk.createdAt !== null ? pk.createdAt.slice(0, 10) : null;
                    return (
                      <article
                        key={pk.id}
                        data-testid={`settings-passkey-${pk.id}`}
                        className="space-y-2 rounded-xl border p-3"
                        style={{
                          borderColor: "var(--border-subtle)",
                          backgroundColor: "var(--surface-subtle)",
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="break-words text-sm font-bold">{label}</div>
                            <div style={{ color: "var(--ink-muted)" }}>
                              {deviceLabel}
                              {createdDate !== null ? ` ・ 登録日 ${createdDate}` : ""}
                            </div>
                          </div>
                          {!isConfirmingDelete ? (
                            <button
                              type="button"
                              data-testid={`btn-request-delete-passkey-${pk.id}`}
                              disabled={deletingPasskeyId !== null}
                              onClick={() => setPendingDeletePasskeyId(pk.id)}
                              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-45"
                              style={{
                                borderColor: "var(--tone-decline-border)",
                                backgroundColor: "var(--surface-card)",
                                color: "var(--tone-decline)",
                              }}
                            >
                              削除
                            </button>
                          ) : null}
                        </div>

                        {isConfirmingDelete ? (
                          <div
                            role="alert"
                            data-testid={`passkey-delete-confirm-${pk.id}`}
                            className="space-y-2 rounded-xl border p-2.5"
                            style={{
                              borderColor: "var(--tone-decline-border)",
                              backgroundColor: "var(--tone-decline-bg)",
                            }}
                          >
                            <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
                              このパスキーを削除しますか？（取り消し不可）
                            </div>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                data-testid={`btn-cancel-delete-passkey-${pk.id}`}
                                disabled={isDeleting}
                                onClick={() => setPendingDeletePasskeyId(null)}
                                className="inline-flex min-h-[44px] min-w-[44px] flex-1 cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
                                style={{
                                  borderColor: "var(--border-default)",
                                  backgroundColor: "var(--surface-card)",
                                  color: "var(--ink-primary)",
                                }}
                              >
                                キャンセル
                              </button>
                              <button
                                type="button"
                                data-testid={`btn-confirm-delete-passkey-${pk.id}`}
                                disabled={isDeleting}
                                onClick={() => {
                                  void handleConfirmDeletePasskey(pk);
                                }}
                                className="inline-flex min-h-[44px] min-w-[44px] flex-1 cursor-pointer items-center justify-center rounded-xl px-3 font-bold"
                                style={{
                                  backgroundColor: "var(--tone-decline)",
                                  color: "var(--accent-primary-ink)",
                                }}
                              >
                                {isDeleting ? "削除中…" : "削除を実行"}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}

              <p style={{ color: "var(--ink-muted)" }}>
                すべてのパスキーを削除しても、登録済みのメールアドレス＋パスワードで引き続きサインインできます。
              </p>
            </section>
          </div>
        ) : null}

        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border-subtle)",
            backgroundColor: "var(--surface-card)",
            color: "var(--ink-muted)",
          }}
        >
          {statusMessage}
        </div>
      </div>

      <BottomNav activeTab="settings" onSelectTab={handleSelectNav} />
    </div>
  );
}
