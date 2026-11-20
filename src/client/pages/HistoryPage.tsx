import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { DomainError, type TaskStatus } from "@/domain";

import { ClientAuthError, ClientTransportError } from "../api/decision-client";
import {
  fetchHumanHistory,
  type HistoryFilterType,
  type HistoryItemDto,
} from "../api/human-api-client";
import { BottomNav, type NavTabId } from "../components/BottomNav";
import { buildSignInRedirectPath } from "../router";

export interface HistoryPageProps {
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

const HISTORY_FILTERS: ReadonlyArray<{ readonly id: HistoryFilterType; readonly label: string }> = [
  { id: "all", label: "すべて" },
  { id: "accepted", label: "採用確定" },
  { id: "declined", label: "見送り確定" },
  { id: "failed", label: "実行失敗 (BOT-03)" },
];

function formatFinalizedTime(ms: number): string {
  const date = new Date(ms);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

function renderExecutionBadge(status: TaskStatus): {
  readonly label: string;
  readonly tone: string;
  readonly bg: string;
  readonly border: string;
} {
  switch (status) {
    case "done":
      return {
        label: "実行完了",
        tone: "var(--tone-accept)",
        bg: "var(--tone-accept-bg)",
        border: "var(--tone-accept-border)",
      };
    case "failed":
      return {
        label: "実行失敗 (BOT-03)",
        tone: "var(--tone-decline)",
        bg: "var(--tone-decline-bg)",
        border: "var(--tone-decline-border)",
      };
    case "blocked":
      return {
        label: "停止中",
        tone: "var(--tone-warn)",
        bg: "var(--tone-warn-bg)",
        border: "var(--tone-warn-border)",
      };
    case "running":
      return {
        label: "Bot実行中",
        tone: "var(--accent-link)",
        bg: "var(--tone-info-bg)",
        border: "var(--tone-info-border)",
      };
    case "waiting_human":
      return {
        label: "次判断待ち",
        tone: "var(--tone-warn)",
        bg: "var(--tone-warn-bg)",
        border: "var(--tone-warn-border)",
      };
    case "ready":
      return {
        label: "再開待機中",
        tone: "var(--ink-muted)",
        bg: "var(--surface-subtle)",
        border: "var(--border-default)",
      };
  }
}

export function HistoryPage(props: HistoryPageProps): ReactElement {
  const { onNavigate } = props;

  const [filter, setFilter] = useState<HistoryFilterType>("all");
  const [items, setItems] = useState<readonly HistoryItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestSeqRef = useRef<number>(0);

  const loadHistory = useCallback(
    async (selectedFilter: HistoryFilterType, cursor?: string): Promise<void> => {
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      if (cursor !== undefined) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setIsLoadingMore(false);
        setItems([]);
        setNextCursor(null);
      }
      setErrorMessage(null);
      try {
        const res = await fetchHumanHistory({
          filter: selectedFilter,
          ...(cursor !== undefined ? { cursor } : {}),
          limit: 20,
        });
        if (requestSeqRef.current !== seq) {
          return;
        }
        setItems((prev) => (cursor !== undefined ? [...prev, ...res.items] : res.items));
        setNextCursor(res.next_cursor);
      } catch (err) {
        if (requestSeqRef.current !== seq) {
          return;
        }
        if (err instanceof ClientAuthError) {
          onNavigate(
            err.status === 401
              ? buildSignInRedirectPath("/history")
              : "/sign-in?error=NOT_AUTHORIZED",
            { replace: true },
          );
          return;
        }
        setErrorMessage(
          err instanceof DomainError || err instanceof ClientTransportError
            ? err.message
            : "履歴の取得に失敗しました。",
        );
      } finally {
        if (requestSeqRef.current === seq) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [onNavigate],
  );

  useEffect(() => {
    void loadHistory(filter);
  }, [filter, loadHistory]);

  const handleSelectNav = useCallback(
    (tab: NavTabId): void => {
      onNavigate(tab === "decide" ? "/" : `/${tab}`);
    },
    [onNavigate],
  );

  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-[960px] flex-col justify-between px-3 py-4 sm:px-5 sm:py-6"
      data-testid="history-page"
    >
      <div className="space-y-4">
        <header className="space-y-2.5">
          <div>
            <h1 className="text-base font-bold tracking-tight">
              確定済み履歴（判断と実行結果を分離記録）
            </h1>
            <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
              5秒の取り消し猶予を経て確定した判断結果と、後続 Bot 実行の成否を分離して記録します。
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="履歴フィルタ">
            {HISTORY_FILTERS.map((entry) => {
              const active = entry.id === filter;
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-testid={`history-filter-${entry.id}`}
                  aria-pressed={active}
                  onClick={() => setFilter(entry.id)}
                  className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
                  style={{
                    borderColor: active ? "var(--accent-primary)" : "var(--border-default)",
                    backgroundColor: active ? "var(--accent-primary)" : "var(--surface-card)",
                    color: active ? "var(--accent-primary-ink)" : "var(--ink-primary)",
                  }}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        </header>

        {errorMessage !== null ? (
          <div
            role="alert"
            data-testid="history-error-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-xs"
            style={{
              borderColor: "var(--tone-warn-border)",
              backgroundColor: "var(--tone-warn-bg)",
            }}
          >
            <div className="min-w-0">
              <div className="font-bold" style={{ color: "var(--tone-warn)" }}>
                履歴取得エラー
              </div>
              <div style={{ color: "var(--ink-muted)" }}>{errorMessage}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                void loadHistory(filter);
              }}
              className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl border px-3 font-semibold"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
                color: "var(--ink-primary)",
              }}
            >
              再試行
            </button>
          </div>
        ) : null}

        {isLoading ? (
          <section
            aria-busy="true"
            data-testid="history-loading"
            className="space-y-3 rounded-2xl border p-4"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--surface-card)",
            }}
          >
            <div
              className="h-16 w-full rounded-xl"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
            <div
              className="h-16 w-full rounded-xl"
              style={{ backgroundColor: "var(--surface-subtle)" }}
            />
            <p
              role="status"
              aria-live="polite"
              className="text-center text-xs"
              style={{ color: "var(--ink-muted)" }}
            >
              GET /api/human/history を読み込み中…
            </p>
          </section>
        ) : items.length === 0 ? (
          errorMessage === null ? (
            <section
              data-testid="history-empty"
              className="space-y-2 rounded-2xl border p-6 text-center bb-card-shadow"
              style={{
                borderColor: "var(--border-default)",
                backgroundColor: "var(--surface-card)",
              }}
            >
              <h2 className="text-base font-bold">確定済みの判断履歴はまだありません</h2>
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                判断画面で採用・見送りを確定すると、ここに判断結果と実行結果が分離して蓄積されます。
              </p>
            </section>
          ) : null
        ) : (
          <div className="space-y-2.5" data-testid="history-list">
            {items.map((item) => {
              const isAccepted = item.decision_result === "accepted";
              const execBadge = renderExecutionBadge(item.execution_status);
              return (
                <article
                  key={item.decision_id}
                  data-testid={`history-item-${item.decision_id}`}
                  className="space-y-1.5 rounded-2xl border p-3.5 text-xs bb-back-shadow"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--surface-card)",
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        data-testid={`history-decision-badge-${item.decision_id}`}
                        className="rounded-md border px-2 py-0.5 font-bold"
                        style={{
                          borderColor: isAccepted
                            ? "var(--tone-accept-border)"
                            : "var(--border-default)",
                          backgroundColor: isAccepted
                            ? "var(--tone-accept-bg)"
                            : "var(--surface-subtle)",
                          color: isAccepted ? "var(--tone-accept)" : "var(--ink-muted)",
                        }}
                      >
                        {isAccepted ? "採用確定" : "見送り確定"}
                      </span>
                      <span
                        data-testid={`history-exec-badge-${item.decision_id}`}
                        className="rounded-md border px-2 py-0.5 font-bold"
                        style={{
                          borderColor: execBadge.border,
                          backgroundColor: execBadge.bg,
                          color: execBadge.tone,
                        }}
                      >
                        {execBadge.label}
                      </span>
                      <span className="font-mono" style={{ color: "var(--ink-muted)" }}>
                        {item.selection_mode}
                      </span>
                    </div>
                    <span className="tabular-nums" style={{ color: "var(--ink-muted)" }}>
                      {item.bot_name} ・ {formatFinalizedTime(item.finalized_at)}
                    </span>
                  </div>

                  <div className="break-words text-sm font-bold">{item.proposal_title}</div>
                  <div className="break-words" style={{ color: "var(--ink-muted)" }}>
                    タスク: {item.task_title}
                  </div>
                  {item.selected_option_ids.length > 0 ? (
                    <div className="font-mono" style={{ color: "var(--ink-muted)" }}>
                      選択ID: {item.selected_option_ids.join(", ")}
                    </div>
                  ) : null}
                  {item.execution_reason !== null && item.execution_reason !== "" ? (
                    <div
                      className="break-words"
                      style={{
                        color:
                          item.execution_status === "failed"
                            ? "var(--tone-decline)"
                            : "var(--ink-muted)",
                      }}
                    >
                      実行詳細: {item.execution_reason}
                    </div>
                  ) : null}
                  {item.artifact !== null ? (
                    <div className="pt-0.5 font-mono" style={{ color: "var(--ink-muted)" }}>
                      成果: {item.artifact.title} v{item.artifact.version}
                    </div>
                  ) : null}
                </article>
              );
            })}

            {nextCursor !== null ? (
              <button
                type="button"
                data-testid="history-load-more-btn"
                disabled={isLoadingMore}
                onClick={() => {
                  void loadHistory(filter, nextCursor);
                }}
                className="inline-flex min-h-[44px] min-w-[44px] w-full cursor-pointer items-center justify-center rounded-xl border px-4 text-xs font-semibold disabled:opacity-50"
                style={{
                  borderColor: "var(--border-default)",
                  backgroundColor: "var(--surface-card)",
                  color: "var(--ink-primary)",
                }}
              >
                {isLoadingMore ? "読み込み中…" : "さらに読み込む（カーソルページング）"}
              </button>
            ) : (
              <div className="text-center text-xs" style={{ color: "var(--ink-muted)" }}>
                全 {items.length} 件を表示済
              </div>
            )}
          </div>
        )}
      </div>

      <BottomNav activeTab="history" onSelectTab={handleSelectNav} />
    </div>
  );
}
