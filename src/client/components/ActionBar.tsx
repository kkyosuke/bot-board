import { type ReactElement } from "react";

import { type DecisionCardItem } from "@/domain";

export interface ActionBarProps {
  readonly card: DecisionCardItem | null;
  readonly disabled: boolean;
  readonly selectedOptionId: string | undefined;
  readonly checkedCount: number;
  readonly onDecline: () => void;
  readonly onDefer: () => void;
  readonly onAccept: () => void;
}

export function ActionBar(props: ActionBarProps): ReactElement {
  const { card, disabled, selectedOptionId, checkedCount, onDecline, onDefer, onAccept } = props;

  const selectedOption = card?.options?.find((opt) => opt.id === selectedOptionId);
  const declineLabel = card === null || card.selectionMode === "binary" ? "見送る" : "全部見送り";
  const acceptLabel =
    card === null || card.selectionMode === "binary"
      ? "採用する"
      : card.selectionMode === "single"
        ? selectedOption !== undefined
          ? `「${selectedOption.title}」確定`
          : "選択を確定"
        : checkedCount > 0
          ? `${checkedCount}件を採用確定`
          : "1件以上選択";

  const acceptDisabled =
    disabled ||
    card === null ||
    (card.selectionMode === "single" && selectedOption === undefined) ||
    (card.selectionMode === "multi" && checkedCount === 0);

  return (
    <div
      className="mt-4 grid w-full max-w-[445px] grid-cols-[minmax(0,1fr)_minmax(56px,auto)_minmax(0,1fr)] gap-2"
      role="group"
      aria-label="カード判断操作"
    >
      <button
        type="button"
        data-testid="btn-decline"
        disabled={disabled || card === null}
        onClick={onDecline}
        aria-label={`左スワイプと同じ：${declineLabel}`}
        className="inline-flex min-h-[50px] min-w-[44px] items-center justify-center gap-1.5 rounded-2xl border px-2.5 text-xs font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm"
        style={{
          backgroundColor: "var(--tone-decline-bg)",
          borderColor: "var(--tone-decline-border)",
          cursor: disabled || card === null ? "not-allowed" : "pointer",
        }}
      >
        <svg
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--tone-decline)" }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        <span className="truncate">{declineLabel}</span>
      </button>

      <button
        type="button"
        data-testid="btn-defer"
        disabled={disabled || card === null}
        onClick={onDefer}
        aria-label="未決定のままあとで回す"
        className="flex min-h-[50px] min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-2xl border px-2 text-xs font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          backgroundColor: "var(--surface-card)",
          borderColor: "var(--border-default)",
          color: "var(--ink-muted)",
          cursor: disabled || card === null ? "not-allowed" : "pointer",
        }}
      >
        <svg
          className="h-4 w-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="whitespace-nowrap">あとで</span>
      </button>

      <button
        type="button"
        data-testid="btn-accept"
        disabled={acceptDisabled}
        onClick={onAccept}
        aria-label={`右スワイプと同じ：${acceptLabel}`}
        className="inline-flex min-h-[50px] min-w-[44px] items-center justify-center gap-1.5 rounded-2xl border px-2.5 text-xs font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm"
        style={{
          backgroundColor: "var(--tone-accept-bg)",
          borderColor: "var(--tone-accept-border)",
          cursor: acceptDisabled ? "not-allowed" : "pointer",
        }}
      >
        <svg
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--tone-accept)" }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span className="truncate">{acceptLabel}</span>
      </button>
    </div>
  );
}
