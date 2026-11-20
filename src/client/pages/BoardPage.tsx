import { type ReactElement, useCallback, useEffect, useState } from "react";

import { DomainError, type TaskStatus } from "@/domain";

import { ClientAuthError, ClientTransportError } from "../api/decision-client";
import {
  type BoardTaskItemDto,
  fetchHumanBoard,
  formatTaskStatusLabel,
  generateClientRequestId,
  type HumanBoardDto,
  retryHumanTaskApi,
} from "../api/human-api-client";
import { BottomNav, type NavTabId } from "../components/BottomNav";
import { buildSignInRedirectPath } from "../router";

export interface BoardPageProps {
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

const KANBAN_COLUMN_ORDER: readonly TaskStatus[] = [
  "failed",
  "waiting_human",
  "running",
  "blocked",
  "ready",
  "done",
];

function getStatusTone(status: TaskStatus): string {
  switch (status) {
    case "failed":
      return "var(--tone-decline)";
    case "waiting_human":
    case "blocked":
      return "var(--tone-warn)";
    case "running":
      return "var(--accent-link)";
    case "done":
      return "var(--tone-accept)";
    case "ready":
      return "var(--ink-muted)";
  }
}

function formatBotSummaryText(counts: {
  readonly running: number;
  readonly waiting_human: number;
  readonly failed: number;
  readonly blocked: number;
  readonly ready: number;
  readonly done: number;
}): string {
  const parts: string[] = [];
  if (counts.failed > 0) parts.push(`失敗 ${counts.failed}件`);
  if (counts.waiting_human > 0) parts.push(`判断待ち ${counts.waiting_human}件`);
  if (counts.running > 0) parts.push(`実行中 ${counts.running}件`);
  if (counts.blocked > 0) parts.push(`停止 ${counts.blocked}件`);
  if (counts.ready > 0) parts.push(`待機 ${counts.ready}件`);
  if (counts.done > 0) parts.push(`完了 ${counts.done}件`);
  return parts.length > 0 ? parts.join(" ・ ") : "担当タスクなし";
}

function formatErrorText(err: unknown, fallback: string): string {
  if (err instanceof DomainError || err instanceof ClientTransportError) {
    return err.message;
  }
  return fallback;
}

export function BoardPage(props: BoardPageProps): ReactElement {
  const { onNavigate } = props;

  const [board, setBoard] = useState<HumanBoardDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>(
    "読み取り専用ビュー：タスク編集・列移動なしで状況確認と失敗再試行のみ操作できます。",
  );

  const loadBoard = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorBanner(null);
    try {
      const data = await fetchHumanBoard();
      setBoard(data);
    } catch (err) {
      if (err instanceof ClientAuthError) {
        onNavigate(
          err.status === 401 ? buildSignInRedirectPath("/board") : "/sign-in?error=NOT_AUTHORIZED",
          { replace: true },
        );
        return;
      }
      setErrorBanner(formatErrorText(err, "状況データの取得に失敗しました。"));
    } finally {
      setIsLoading(false);
    }
  }, [onNavigate]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const handleRetryTask = useCallback(
    async (task: BoardTaskItemDto): Promise<void> => {
      if (retryingTaskId !== null) {
        return;
      }
      setRetryingTaskId(task.id);
      setErrorBanner(null);
      try {
        const res = await retryHumanTaskApi(task.id, {
          requestId: generateClientRequestId("retry"),
          expectedVersion: task.version,
        });
        setStatusMessage(
          `「${task.title}」を再試行キュー（ready / v${res.version}）へ戻しました。`,
        );
        await loadBoard();
      } catch (err) {
        if (err instanceof ClientAuthError) {
          onNavigate(
            err.status === 401
              ? buildSignInRedirectPath("/board")
              : "/sign-in?error=NOT_AUTHORIZED",
            { replace: true },
          );
          return;
        }
        setErrorBanner(
          formatErrorText(err, "再試行の送信に失敗しました。最新を再取得してください。"),
        );
      } finally {
        setRetryingTaskId(null);
      }
    },
    [loadBoard, onNavigate, retryingTaskId],
  );

  const handleSelectNav = useCallback(
    (tab: NavTabId): void => {
      onNavigate(tab === "decide" ? "/" : `/${tab}`);
    },
    [onNavigate],
  );

  const hasActiveBots = board !== null && board.bots.some((b) => b.status !== "revoked");
  const isEmpty = board !== null && board.tasks.length === 0;

  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col justify-between px-3 py-4 sm:px-5 sm:py-6"
      data-testid="board-page"
    >
      <div className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight">状況（読み取り専用カンバン）</h1>
            <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
              UX-01: 列移動・タスク編集なし。失敗・停止タスクのみ再試行できます。
            </p>
          </div>
          <button
            type="button"
            data-testid="board-refresh-btn"
            disabled={isLoading}
            onClick={() => {
              void loadBoard();
            }}
            className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold disabled:opacity-50"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
              color: "var(--ink-primary)",
            }}
          >
            最新を取得
          </button>
        </header>

        {board?.workspace.is_paused === true ? (
          <div
            role="alert"
            data-testid="board-paused-banner"
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
                全 Bot の新規占有・書込および Queue ワーカー起動を停止中です（閲覧のみ可）。
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate("/settings")}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-3 font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              設定で解除
            </button>
          </div>
        ) : null}

        {errorBanner !== null ? (
          <div
            role="alert"
            data-testid="board-error-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-xs"
            style={{
              borderColor: "var(--tone-warn-border)",
              backgroundColor: "var(--tone-warn-bg)",
            }}
          >
            <div className="min-w-0">
              <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                更新エラー / 版競合（未反映）
              </div>
              <div style={{ color: "var(--ink-muted)" }}>{errorBanner}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                void loadBoard();
              }}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
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

        {isLoading && board === null ? (
          <section
            aria-busy="true"
            data-testid="board-loading"
            className="space-y-3 rounded-2xl border p-4"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div
              className="h-5 w-40 rounded"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
            <div
              className="h-16 w-full rounded-xl"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
            <div
              className="h-20 w-full rounded-xl"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
            <p
              role="status"
              aria-live="polite"
              className="text-center text-xs"
              style={{ color: "var(--ink-muted)" }}
            >
              GET /api/human/board を読み込み中…
            </p>
          </section>
        ) : board !== null && !hasActiveBots && isEmpty ? (
          <section
            data-testid="board-empty-disconnected"
            className="space-y-3 rounded-2xl border p-6 text-center bb-card-shadow"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <h2 className="text-base font-bold">接続済みの Bot がありません</h2>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              設定画面から目的・上限を保存し、MCP OAuth 同意または Worker Bearer 発行で Bot
              を接続してください。
            </p>
            <button
              type="button"
              onClick={() => onNavigate("/settings")}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              接続・設定画面を開く
            </button>
          </section>
        ) : board !== null && isEmpty ? (
          <section
            data-testid="board-empty"
            className="space-y-3 rounded-2xl border p-6 text-center bb-card-shadow"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <h2 className="text-base font-bold">進行中のタスクはまだありません</h2>
            <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
              Bot がタスクを作成すると、ここに Bot ごとの進行状況と 6
              列の読み取り専用カンバンが表示されます。
            </p>
            <button
              type="button"
              onClick={() => onNavigate("/")}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              判断画面を見る
            </button>
          </section>
        ) : board !== null ? (
          <>
            {/* Per-Bot Progress Strip */}
            <section className="space-y-2" data-testid="board-bot-strip">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <h2 className="text-sm font-bold">Bot ごとの進行状況</h2>
                <span style={{ color: "var(--ink-muted)" }}>
                  全 {board.tasks.length} タスク ・ 稼働/待機/失敗サマリー
                </span>
              </div>
              {board.bots.length === 0 ? (
                <div
                  className="rounded-xl border p-3 text-xs"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-card)",
                    color: "var(--ink-muted)",
                  }}
                >
                  接続中の Bot は 0 件です。
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                  {board.bots.map((bot) => (
                    <div
                      key={bot.id}
                      data-testid={`board-bot-${bot.id}`}
                      className="min-w-0 space-y-1 rounded-xl border p-2.5"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                      }}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-1">
                        <span className="min-w-0 truncate font-bold">{bot.display_name}</span>
                        <span
                          className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px]"
                          style={{
                            borderColor: "var(--border-default)",
                            color: "var(--ink-muted)",
                          }}
                        >
                          {bot.status}
                        </span>
                      </div>
                      <div
                        className="break-words leading-snug"
                        style={{ color: "var(--ink-muted)" }}
                      >
                        {formatBotSummaryText(bot.counts)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 6-Column Read-Only Kanban (UX-01: zero drag, zero edit) */}
            <section className="space-y-2" data-testid="board-kanban">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {KANBAN_COLUMN_ORDER.map((status) => {
                  const items = board.columns[status];
                  return (
                    <section
                      key={status}
                      data-testid={`kanban-col-${status}`}
                      className="space-y-2 rounded-2xl border p-3"
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--surface-card)",
                      }}
                    >
                      <div className="flex items-center justify-between text-xs font-bold">
                        <span style={{ color: getStatusTone(status) }}>
                          {formatTaskStatusLabel(status)}
                        </span>
                        <span
                          className="rounded-md px-2 py-0.5 tabular-nums"
                          style={{
                            backgroundColor: "var(--surface-subtle)",
                            color: "var(--ink-muted)",
                          }}
                        >
                          {items.length}
                        </span>
                      </div>

                      {items.length === 0 ? (
                        <div className="text-xs" style={{ color: "var(--ink-muted)" }}>
                          0件
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {items.map((task) => {
                            const canRetry = task.status === "failed" || task.status === "blocked";
                            return (
                              <article
                                key={task.id}
                                data-testid={`board-task-${task.id}`}
                                className="space-y-1.5 rounded-xl border p-2.5 text-xs"
                                style={{
                                  borderColor: "var(--border-subtle)",
                                  backgroundColor: "var(--surface-subtle)",
                                }}
                              >
                                <div
                                  className="flex min-w-0 items-center justify-between gap-1"
                                  style={{ color: "var(--ink-muted)" }}
                                >
                                  <span className="min-w-0 truncate">
                                    {task.assigned_bot_name ?? "未割当"}
                                  </span>
                                  <span className="shrink-0 font-mono">v{task.version}</span>
                                </div>
                                <div className="break-words font-bold leading-snug">
                                  {task.title}
                                </div>
                                {task.retry_count > 0 || task.status === "failed" ? (
                                  <div
                                    data-testid={`board-task-retry-count-${task.id}`}
                                    className="font-mono leading-snug"
                                    style={{
                                      color:
                                        task.status === "failed"
                                          ? "var(--tone-decline)"
                                          : "var(--ink-muted)",
                                    }}
                                  >
                                    再試行回数: {task.retry_count}回
                                  </div>
                                ) : null}
                                {task.status_reason !== null && task.status_reason !== "" ? (
                                  <div
                                    data-testid={`board-task-reason-${task.id}`}
                                    className="break-words leading-snug"
                                    style={{
                                      color:
                                        task.status === "failed"
                                          ? "var(--tone-decline)"
                                          : "var(--ink-muted)",
                                    }}
                                  >
                                    {task.status_reason}
                                  </div>
                                ) : null}
                                {task.active_lease !== null ? (
                                  <div
                                    data-testid={`board-task-lease-${task.id}`}
                                    className="leading-snug"
                                    style={{ color: "var(--ink-muted)" }}
                                  >
                                    WorkLease 占有中
                                  </div>
                                ) : null}
                                {canRetry ? (
                                  <button
                                    type="button"
                                    data-testid={`btn-retry-task-${task.id}`}
                                    disabled={retryingTaskId !== null}
                                    onClick={() => {
                                      void handleRetryTask(task);
                                    }}
                                    className="mt-1 inline-flex min-h-[44px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-45"
                                    style={{
                                      backgroundColor: "var(--accent-primary)",
                                      color: "var(--accent-primary-ink)",
                                    }}
                                  >
                                    {retryingTaskId === task.id
                                      ? "再試行を送信中…"
                                      : "再試行する (→ ready)"}
                                  </button>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          </>
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

      <BottomNav activeTab="board" onSelectTab={handleSelectNav} />
    </div>
  );
}
