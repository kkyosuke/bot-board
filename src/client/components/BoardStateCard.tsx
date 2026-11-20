import { type ReactElement } from "react";

import { type BoardViewState } from "@/domain";

export interface BoardStateCardProps {
  readonly viewState: Exclude<BoardViewState, "normal" | "offline_error">;
  readonly clearedCount: number;
  readonly deferredCount: number;
  readonly isLiveMode?: boolean;
  readonly runningTaskCount?: number;
  readonly onOpenDeferred: () => void;
  readonly onResetDemo: () => void;
  readonly onOpenConnectHint: () => void;
}

export function BoardStateCard(props: BoardStateCardProps): ReactElement {
  const {
    viewState,
    clearedCount,
    deferredCount,
    isLiveMode = false,
    runningTaskCount = 0,
    onOpenDeferred,
    onResetDemo,
    onOpenConnectHint,
  } = props;

  if (viewState === "loading") {
    return (
      <div
        data-testid="state-card-loading"
        className="bb-card-shadow flex w-full flex-col justify-between rounded-2xl border p-5"
        style={{
          backgroundColor: "var(--surface-card)",
          borderColor: "var(--border-default)",
        }}
      >
        <div className="space-y-4">
          <div className="flex justify-between">
            <div className="bb-skeleton h-5 w-28 rounded-md" />
            <div className="bb-skeleton h-5 w-20 rounded-md" />
          </div>
          <div className="space-y-2">
            <div className="bb-skeleton h-6 w-11/12 rounded-md" />
            <div className="bb-skeleton h-6 w-2/3 rounded-md" />
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <div className="bb-skeleton h-24 rounded-xl" />
            <div className="bb-skeleton h-24 rounded-xl" />
          </div>
          <div className="bb-skeleton h-24 rounded-xl" />
        </div>
        <p className="pt-3 text-center text-xs" style={{ color: "var(--ink-muted)" }}>
          最新の判断カードを読み込み中…
        </p>
      </div>
    );
  }

  if (viewState === "empty") {
    return (
      <div
        data-testid="state-card-empty"
        className="bb-card-shadow flex w-full flex-col items-center justify-center gap-4 rounded-2xl border p-6 text-center"
        style={{
          backgroundColor: "var(--surface-card)",
          borderColor: "var(--border-default)",
        }}
      >
        <div
          className="flex h-14 w-14 items-center justify-center rounded-2xl border"
          style={{
            backgroundColor: "var(--tone-accept-bg)",
            borderColor: "var(--tone-accept-border)",
          }}
        >
          <svg
            className="h-7 w-7"
            style={{ color: "var(--tone-accept)" }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-bold tracking-tight">すべての判断をクリアしました</h2>
          <p
            className="mx-auto max-w-xs text-xs leading-relaxed sm:text-sm"
            style={{ color: "var(--ink-muted)" }}
          >
            採用した方針・選択結果をもとにBotが次の作業を進めています。新しい判断が必要になったらカードが届きます。
          </p>
        </div>

        <div className="grid w-full max-w-xs grid-cols-2 gap-2 text-xs">
          <div
            className="rounded-xl border p-2.5"
            style={{
              backgroundColor: "var(--surface-subtle)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <div style={{ color: "var(--ink-muted)" }}>このセッション消費</div>
            <div className="mt-0.5 text-base font-bold tabular-nums">{clearedCount} 件</div>
          </div>
          <div
            className="rounded-xl border p-2.5"
            style={{
              backgroundColor: "var(--surface-subtle)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <div style={{ color: "var(--ink-muted)" }}>あとで保留</div>
            <div className="mt-0.5 text-base font-bold tabular-nums">{deferredCount} 件</div>
          </div>
        </div>

        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {deferredCount > 0 ? (
            <button
              type="button"
              onClick={onOpenDeferred}
              className="min-h-[44px] cursor-pointer rounded-xl px-4 text-xs font-semibold"
              style={{
                backgroundColor: "var(--accent-primary)",
                color: "var(--accent-primary-ink)",
              }}
            >
              保留カード（{deferredCount}件）を見る
            </button>
          ) : null}
          <button
            type="button"
            data-testid="btn-empty-reset"
            onClick={onResetDemo}
            className="min-h-[44px] cursor-pointer rounded-xl border px-4 text-xs font-semibold"
            style={{
              backgroundColor: "var(--surface-card)",
              borderColor: "var(--border-default)",
            }}
          >
            {isLiveMode ? "最新を再取得" : "サンプル6件をもう一度試す"}
          </button>
        </div>
      </div>
    );
  }

  if (viewState === "bot_running") {
    return (
      <div
        data-testid="state-card-bot-running"
        className="bb-card-shadow flex w-full flex-col items-center justify-center gap-4 rounded-2xl border p-6 text-center"
        style={{
          backgroundColor: "var(--surface-card)",
          borderColor: "var(--border-default)",
        }}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-2xl border"
          style={{
            backgroundColor: "var(--tone-info-bg)",
            borderColor: "var(--tone-info-border)",
          }}
        >
          <svg
            className="h-6 w-6"
            style={{ color: "var(--accent-link)" }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-bold">Botが作業を進めています</h2>
          <p
            className="mx-auto max-w-xs text-xs leading-relaxed sm:text-sm"
            style={{ color: "var(--ink-muted)" }}
          >
            現在、人の判断待ちカードは0件です。方針確認や成果受入が必要になると自動で届きます。
          </p>
        </div>
        {isLiveMode ? (
          <div
            className="w-full max-w-xs space-y-2 rounded-xl border p-3 text-left text-xs"
            style={{
              backgroundColor: "var(--surface-subtle)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <div className="flex justify-between font-semibold">
              <span>稼働中タスク</span>
              <span className="tabular-nums" style={{ color: "var(--accent-link)" }}>
                {runningTaskCount} 件実行中
              </span>
            </div>
            <div style={{ color: "var(--ink-muted)" }}>
              進行状況や失敗理由は状況画面（/board）で確認できます。
            </div>
            <button
              type="button"
              data-testid="btn-running-refresh"
              onClick={onResetDemo}
              className="mt-1 inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-xl border px-3 text-xs font-semibold"
              style={{
                backgroundColor: "var(--surface-card)",
                borderColor: "var(--border-default)",
              }}
            >
              最新を再取得
            </button>
          </div>
        ) : (
          <div
            className="w-full max-w-xs space-y-1 rounded-xl border p-3 text-left text-xs"
            style={{
              backgroundColor: "var(--surface-subtle)",
              borderColor: "var(--border-subtle)",
            }}
          >
            <div className="flex justify-between font-semibold">
              <span>Claude</span>
              <span style={{ color: "var(--ink-muted)" }}>実行中</span>
            </div>
            <div style={{ color: "var(--ink-muted)" }}>
              担当タスク：認証設計ドキュメントの下書き作成
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="state-card-bot-disconnected"
      className="bb-card-shadow flex w-full flex-col items-center justify-center gap-4 rounded-2xl border p-6 text-center"
      style={{
        backgroundColor: "var(--surface-card)",
        borderColor: "var(--border-default)",
      }}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-2xl border"
        style={{
          backgroundColor: "var(--tone-warn-bg)",
          borderColor: "var(--tone-warn-border)",
        }}
      >
        <svg
          className="h-6 w-6"
          style={{ color: "var(--tone-warn)" }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>
      <div className="space-y-1.5">
        <h2 className="text-base font-bold">Botがまだ接続されていません</h2>
        <p
          className="mx-auto max-w-xs text-xs leading-relaxed sm:text-sm"
          style={{ color: "var(--ink-muted)" }}
        >
          ChatGPT・Claude
          等のMCP接続またはAPIワーカーを設定すると、タスク作成と判断カードの提案が始まります。
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenConnectHint}
        className="min-h-[44px] cursor-pointer rounded-xl px-4 text-xs font-semibold"
        style={{
          backgroundColor: "var(--accent-primary)",
          color: "var(--accent-primary-ink)",
        }}
      >
        接続・初期設定へ進む
      </button>
    </div>
  );
}
