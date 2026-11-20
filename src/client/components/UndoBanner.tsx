import { type ReactElement } from "react";

import { PROVISIONAL_UNDO_WINDOW_MS } from "@/domain";

export interface ProvisionalToastEntry {
  readonly cardId: string;
  readonly headline: string;
  readonly label: string;
  readonly isDecline: boolean;
  readonly expectedVersion: number;
  readonly provisionalUntil: number;
}

export interface UndoBannerProps {
  readonly latestEntry: ProvisionalToastEntry | null;
  readonly extraCount: number;
  readonly nowMs: number;
  readonly isBusy: boolean;
  readonly onUndo: () => void;
}

export function UndoBanner(props: UndoBannerProps): ReactElement {
  const { latestEntry, extraCount, nowMs, isBusy, onUndo } = props;

  if (latestEntry === null) {
    return <div className="mt-3 min-h-[62px] w-full max-w-[445px]" />;
  }

  const remainingMs = Math.max(0, latestEntry.provisionalUntil - nowMs);
  const remainingSec = (remainingMs / 1000).toFixed(1);
  const progressPct = Math.max(0, Math.min(100, (remainingMs / PROVISIONAL_UNDO_WINDOW_MS) * 100));
  const accentColor = latestEntry.isDecline ? "var(--tone-decline)" : "var(--tone-accept)";

  return (
    <div
      data-testid="undo-banner"
      className="bb-card-shadow mt-3 min-h-[62px] w-full max-w-[445px] overflow-hidden rounded-2xl border"
      style={{
        backgroundColor: "var(--surface-card)",
        borderColor: "var(--border-default)",
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {latestEntry.label}：{latestEntry.headline}。5秒以内に取り消せます。
      </span>
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="min-w-0 text-xs">
          <div className="flex items-center gap-1.5 font-semibold">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
            <span className="truncate">{latestEntry.label}</span>
            <span
              aria-hidden="true"
              className="shrink-0 font-normal tabular-nums"
              style={{ color: "var(--ink-muted)" }}
            >
              {remainingSec}秒後に確定{extraCount > 0 ? `（他${extraCount}件）` : ""}
            </span>
          </div>
          <div className="mt-0.5 truncate" style={{ color: "var(--ink-muted)" }}>
            {latestEntry.headline}
          </div>
        </div>
        <button
          type="button"
          data-testid="btn-undo"
          disabled={isBusy}
          onClick={onUndo}
          className="min-h-[44px] min-w-[44px] shrink-0 cursor-pointer rounded-xl px-3.5 text-xs font-bold transition hover:opacity-90 disabled:opacity-50"
          style={{
            backgroundColor: "var(--accent-primary)",
            color: "var(--accent-primary-ink)",
          }}
        >
          取り消す (Z)
        </button>
      </div>
      <div className="h-1 w-full" style={{ backgroundColor: "var(--surface-subtle)" }}>
        <div
          className="h-full"
          style={{
            width: `${progressPct}%`,
            backgroundColor: accentColor,
          }}
        />
      </div>
    </div>
  );
}
