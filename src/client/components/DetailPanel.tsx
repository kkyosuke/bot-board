import { type ReactElement } from "react";

import { type DecisionCardItem } from "@/domain";

export interface ActivityLogEntry {
  readonly id: string;
  readonly time: string;
  readonly kind: "accepted" | "declined" | "undo" | "defer" | "finalized" | "error";
  readonly title: string;
  readonly detail: string;
  readonly payloadJson?: string;
}

export interface DetailContentProps {
  readonly card: DecisionCardItem | null;
}

export function CardDetailContent(props: DetailContentProps): ReactElement {
  const { card } = props;

  if (card === null) {
    return (
      <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
        現在表示中の判断カードはありません。
      </p>
    );
  }

  const options = card.options ?? [];

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs" style={{ color: "var(--ink-muted)" }}>
          {card.taskTitle} ・ 版 v{card.version}
        </div>
        <h3 className="mt-0.5 text-base leading-snug font-bold">{card.headline}</h3>
      </div>

      <div
        className="space-y-1.5 rounded-xl border p-3"
        style={{
          backgroundColor: "var(--surface-subtle)",
          borderColor: "var(--border-subtle)",
        }}
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-semibold">{card.artifact.title}</span>
          <span style={{ color: "var(--ink-muted)" }}>{card.artifact.kind}</span>
        </div>
        <div className="font-mono text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
          {card.artifact.excerpt.map((line, index) => (
            <div key={`${index}-${line}`} className="py-0.5">
              {line}
            </div>
          ))}
        </div>
      </div>

      {options.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-xs font-bold">
            {card.selectionMode === "single"
              ? `全${options.length}案の比較一覧（排他選択）`
              : `全${options.length}項目の詳細`}
          </div>
          {options.map((opt) => (
            <div
              key={opt.id}
              className="rounded-xl border p-2.5 text-xs"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <div className="flex items-center justify-between gap-2 font-bold">
                <span>{opt.title}</span>
                {opt.badge !== undefined ? (
                  <span className="font-normal" style={{ color: "var(--ink-muted)" }}>
                    {opt.badge}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5" style={{ color: "var(--ink-muted)" }}>
                {opt.summary}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-1.5 text-xs">
        <div
          className="rounded-xl border p-2.5"
          style={{
            backgroundColor: "var(--tone-accept-bg)",
            borderColor: "var(--tone-accept-border)",
          }}
        >
          <strong style={{ color: "var(--tone-accept)" }}>採用時：</strong>
          {card.acceptEffect}
        </div>
        <div
          className="rounded-xl border p-2.5"
          style={{
            backgroundColor: "var(--tone-decline-bg)",
            borderColor: "var(--tone-decline-border)",
          }}
        >
          <strong style={{ color: "var(--tone-decline)" }}>見送り時：</strong>
          {card.declineEffect}
        </div>
      </div>
    </div>
  );
}

export interface ActivityLogListProps {
  readonly logs: readonly ActivityLogEntry[];
}

export function ActivityLogList(props: ActivityLogListProps): ReactElement {
  const { logs } = props;

  if (logs.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
        カードを操作すると、仮確定（5秒猶予）・取消・確定イベントがここに記録されます。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {logs.map((item) => {
        const titleColor =
          item.kind === "accepted" || item.kind === "finalized"
            ? "var(--tone-accept)"
            : item.kind === "declined" || item.kind === "error"
              ? "var(--tone-decline)"
              : "var(--ink-muted)";

        return (
          <div
            key={item.id}
            className="space-y-1 rounded-xl border p-2.5 text-xs"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-semibold" style={{ color: titleColor }}>
                {item.title}
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: "var(--ink-muted)" }}>
                {item.time}
              </span>
            </div>
            <div style={{ color: "var(--ink-muted)" }}>{item.detail}</div>
            {item.payloadJson !== undefined ? (
              <div
                className="rounded p-1.5 font-mono text-xs break-all"
                style={{
                  backgroundColor: "var(--surface-subtle)",
                  color: "var(--ink-muted)",
                }}
              >
                {item.payloadJson}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
