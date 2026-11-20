import { type PointerEvent, type ReactElement } from "react";

import { type DecisionCardItem, type SwipeVisualState } from "@/domain";

export interface DecisionCardProps {
  readonly card: DecisionCardItem;
  readonly layerIndex: number;
  readonly swipeVisual: SwipeVisualState | null;
  readonly flyDirection: "right" | "left" | "down" | null;
  readonly isDragging: boolean;
  readonly selectedOptionId: string | undefined;
  readonly checkedOptionIds: readonly string[];
  readonly onSelectOption: (optionId: string) => void;
  readonly onToggleOption: (optionId: string) => void;
  readonly onToggleAllOptions: () => void;
  readonly onOpenDetail: () => void;
  readonly onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp?: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel?: (event: PointerEvent<HTMLElement>) => void;
}

function getCardTransform(
  layerIndex: number,
  swipeVisual: SwipeVisualState | null,
  flyDirection: "right" | "left" | "down" | null,
): { readonly transform: string; readonly opacity: number } {
  if (layerIndex === 0) {
    if (flyDirection === "right") {
      return { transform: "translate3d(480px, -18px, 0) rotate(15deg)", opacity: 0 };
    }
    if (flyDirection === "left") {
      return { transform: "translate3d(-480px, -18px, 0) rotate(-15deg)", opacity: 0 };
    }
    if (flyDirection === "down") {
      return { transform: "translate3d(0, 150px, 0) scale(0.92)", opacity: 0 };
    }
    if (swipeVisual !== null) {
      return {
        transform: `translate3d(${swipeVisual.translateX}px, ${swipeVisual.translateY}px, 0) rotate(${swipeVisual.rotationDeg}deg)`,
        opacity: 1,
      };
    }
    return { transform: "translate3d(0, 0, 0) scale(1) rotate(0deg)", opacity: 1 };
  }

  if (layerIndex === 1) {
    const progress = swipeVisual?.progress ?? 0;
    const liftY = 10 * (1 - progress);
    const scale = 0.96 + 0.04 * progress;
    const opacity = 0.72 + 0.28 * progress;
    return {
      transform: `translate3d(0, ${liftY}px, 0) scale(${scale})`,
      opacity,
    };
  }

  return {
    transform: "translate3d(0, 20px, 0) scale(0.92)",
    opacity: 0.4,
  };
}

export function DecisionCard(props: DecisionCardProps): ReactElement {
  const {
    card,
    layerIndex,
    swipeVisual,
    flyDirection,
    isDragging,
    selectedOptionId,
    checkedOptionIds,
    onSelectOption,
    onToggleOption,
    onToggleAllOptions,
    onOpenDetail,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = props;

  const isTop = layerIndex === 0;
  const { transform, opacity } = getCardTransform(layerIndex, swipeVisual, flyDirection);
  const progress = isTop ? (swipeVisual?.progress ?? 0) : 0;
  const direction = isTop ? (swipeVisual?.direction ?? "neutral") : "neutral";
  const acceptStampOpacity = flyDirection === "right" ? 1 : direction === "right" ? progress : 0;
  const declineStampOpacity = flyDirection === "left" ? 1 : direction === "left" ? progress : 0;

  const options = card.options ?? [];
  const checkedSet = new Set(checkedOptionIds);
  const selectedOption = options.find((opt) => opt.id === selectedOptionId);

  const isMultiAcceptBlocked = card.selectionMode === "multi" && checkedSet.size === 0;
  const rightStampLabel =
    card.selectionMode === "binary"
      ? "採用する"
      : card.selectionMode === "single"
        ? selectedOption !== undefined
          ? `「${selectedOption.title}」確定`
          : "選択確定"
        : isMultiAcceptBlocked
          ? "1件以上選択"
          : `${checkedSet.size}件を採用`;
  const rightStampColor = isMultiAcceptBlocked ? "var(--tone-warn)" : "var(--tone-accept)";
  const leftStampLabel = card.selectionMode === "binary" ? "見送る" : "全部見送り";

  const motionClass = isTop
    ? flyDirection !== null
      ? "bb-fly-out"
      : isDragging
        ? ""
        : "bb-spring"
    : isDragging
      ? ""
      : "bb-stack-lift";

  const typeBadgeStyle =
    card.cardType === "deliverable"
      ? {
          backgroundColor: "var(--tone-accept-bg)",
          borderColor: "var(--tone-accept-border)",
        }
      : card.selectionMode !== "binary"
        ? {
            backgroundColor: "var(--tone-info-bg)",
            borderColor: "var(--tone-info-border)",
          }
        : {
            backgroundColor: "var(--surface-subtle)",
            borderColor: "var(--border-subtle)",
          };

  return (
    <article
      data-testid={isTop ? "top-decision-card" : `back-decision-card-${layerIndex}`}
      data-card-id={card.id}
      data-selection-mode={card.selectionMode}
      aria-hidden={!isTop}
      inert={!isTop}
      onPointerDown={isTop ? onPointerDown : undefined}
      onPointerMove={isTop ? onPointerMove : undefined}
      onPointerUp={isTop ? onPointerUp : undefined}
      onPointerCancel={isTop ? onPointerCancel : undefined}
      className={`absolute inset-0 flex flex-col justify-between overflow-hidden rounded-2xl border p-3.5 sm:p-5 ${
        isTop
          ? "bb-card-shadow cursor-grab active:cursor-grabbing"
          : "bb-back-shadow pointer-events-none"
      } ${motionClass}`}
      style={{
        backgroundColor: "var(--surface-card)",
        borderColor: "var(--border-default)",
        transform,
        opacity,
        zIndex: 20 - layerIndex,
        ...(isTop ? { touchAction: "pan-y" } : {}),
      }}
    >
      {isTop && flyDirection === "right" ? (
        <div
          className="bb-slash-beam"
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--tone-accept-border), transparent)",
          }}
        />
      ) : null}

      {isTop && flyDirection === "left" ? (
        <div
          className="bb-slash-beam"
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--tone-decline-border), transparent)",
          }}
        />
      ) : null}

      {isTop ? (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-4 left-4 z-30 rounded-xl border-2 px-3 py-1 text-xs font-bold sm:text-sm"
            style={{
              borderColor: rightStampColor,
              color: rightStampColor,
              backgroundColor: "var(--surface-card)",
              opacity: acceptStampOpacity,
              transform: "rotate(-7deg)",
            }}
          >
            {rightStampLabel}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-4 right-4 z-30 rounded-xl border-2 px-3 py-1 text-xs font-bold sm:text-sm"
            style={{
              borderColor: "var(--tone-decline)",
              color: "var(--tone-decline)",
              backgroundColor: "var(--surface-card)",
              opacity: declineStampOpacity,
              transform: "rotate(7deg)",
            }}
          >
            {leftStampLabel}
          </div>
        </>
      ) : null}

      <div className="bb-card-scroll flex-1 space-y-3 overflow-y-auto pr-0.5">
        {/* Card Header: Type + Task Context + Bot */}
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="shrink-0 rounded-md border px-2 py-0.5 font-semibold"
              style={typeBadgeStyle}
            >
              {card.typeLabel}
            </span>
            <span className="truncate" style={{ color: "var(--ink-muted)" }}>
              {card.taskTitle}
            </span>
          </div>
          <span className="shrink-0 tabular-nums" style={{ color: "var(--ink-muted)" }}>
            {card.botName} ・ {card.submittedAtLabel}
          </span>
        </div>

        {/* Question Headline & Short Summary */}
        <div className="space-y-1.5">
          <h2
            data-testid={isTop ? "card-headline" : undefined}
            className="text-base leading-snug font-bold tracking-tight sm:text-lg"
          >
            {card.headline}
          </h2>
          <p className="text-xs leading-relaxed sm:text-sm" style={{ color: "var(--ink-muted)" }}>
            {card.summary}
          </p>
        </div>

        {/* Mode-Specific Body */}
        {card.selectionMode === "binary" ? (
          <>
            <div className="grid grid-cols-2 gap-2 pt-0.5">
              <div
                data-testid={isTop ? "outcome-decline" : undefined}
                className="rounded-xl border p-2.5 transition-colors"
                style={{
                  backgroundColor:
                    direction === "left" ? "var(--tone-decline-bg)" : "var(--surface-subtle)",
                  borderColor:
                    direction === "left" ? "var(--tone-decline-border)" : "var(--border-subtle)",
                }}
              >
                <div className="text-xs font-semibold" style={{ color: "var(--tone-decline)" }}>
                  ← 見送ると
                </div>
                <p className="mt-1 text-xs leading-snug">{card.declineEffect}</p>
              </div>
              <div
                data-testid={isTop ? "outcome-accept" : undefined}
                className="rounded-xl border p-2.5 transition-colors"
                style={{
                  backgroundColor:
                    direction === "right" ? "var(--tone-accept-bg)" : "var(--surface-subtle)",
                  borderColor:
                    direction === "right" ? "var(--tone-accept-border)" : "var(--border-subtle)",
                }}
              >
                <div className="text-xs font-semibold" style={{ color: "var(--tone-accept)" }}>
                  採用すると →
                </div>
                <p className="mt-1 text-xs leading-snug">{card.acceptEffect}</p>
              </div>
            </div>

            <div
              className="rounded-xl border px-3 py-1.5"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              {card.factors.map((factor) => (
                <div
                  key={factor.label}
                  className="flex items-baseline justify-between gap-2 border-b py-1 text-xs last:border-b-0"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <span className="shrink-0" style={{ color: "var(--ink-muted)" }}>
                    {factor.label}
                  </span>
                  <span className="text-right font-semibold tabular-nums">{factor.value}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {card.selectionMode === "single" ? (
          <div className="space-y-2 pt-0.5" role="radiogroup" aria-label={card.headline}>
            <div className="text-xs" style={{ color: "var(--ink-muted)" }}>
              1案を選んで右スワイプ（または採用ボタン）で確定・左で全案見送り
            </div>
            <div className="space-y-1.5">
              {options.map((option, idx) => {
                const isSelected = option.id === selectedOptionId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-no-drag="true"
                    data-testid={isTop ? `option-radio-${option.id}` : undefined}
                    onClick={() => onSelectOption(option.id)}
                    className="min-h-[46px] w-full cursor-pointer rounded-xl border px-3 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: isSelected ? "var(--tone-accept-bg)" : "var(--surface-card)",
                      borderColor: isSelected
                        ? "var(--tone-accept-border)"
                        : "var(--border-subtle)",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-2 font-bold">
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2"
                          style={{
                            borderColor: isSelected ? "var(--tone-accept)" : "var(--ink-muted)",
                          }}
                        >
                          {isSelected ? (
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: "var(--tone-accept)" }}
                            />
                          ) : null}
                        </span>
                        <span className="truncate">
                          {idx + 1}. {option.title}
                        </span>
                      </span>
                      {option.badge !== undefined ? (
                        <span className="shrink-0 text-xs" style={{ color: "var(--ink-muted)" }}>
                          {option.badge}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 pl-6 text-xs" style={{ color: "var(--ink-muted)" }}>
                      {option.meta}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {card.selectionMode === "multi" ? (
          <div className="space-y-2 pt-0.5" role="group" aria-label={card.headline}>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span style={{ color: "var(--ink-muted)" }}>
                選んで右へ一括スワイプ（{checkedSet.size}/{options.length}件選択中）
              </span>
              <button
                type="button"
                data-no-drag="true"
                data-testid={isTop ? "btn-toggle-all" : undefined}
                onClick={onToggleAllOptions}
                className="min-h-[44px] min-w-[44px] cursor-pointer px-2 text-xs font-semibold"
                style={{ color: "var(--accent-link)" }}
              >
                {checkedSet.size === options.length ? "全解除" : "全選択"}
              </button>
            </div>
            <div className="space-y-1.5">
              {options.map((option, idx) => {
                const isChecked = checkedSet.has(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    data-no-drag="true"
                    data-testid={isTop ? `option-checkbox-${option.id}` : undefined}
                    onClick={() => onToggleOption(option.id)}
                    className="flex min-h-[46px] w-full cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: isChecked ? "var(--tone-accept-bg)" : "var(--surface-card)",
                      borderColor: isChecked ? "var(--tone-accept-border)" : "var(--border-subtle)",
                      opacity: isChecked ? 1 : 0.78,
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2"
                        style={{
                          borderColor: isChecked ? "var(--tone-accept)" : "var(--ink-muted)",
                          backgroundColor: isChecked ? "var(--tone-accept)" : "transparent",
                          color: "#ffffff",
                        }}
                      >
                        {isChecked ? (
                          <svg
                            className="h-3.5 w-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            aria-hidden="true"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-bold">
                          {idx + 1}. {option.title}
                        </span>
                        <span
                          className="block truncate text-xs"
                          style={{ color: "var(--ink-muted)" }}
                        >
                          {option.meta}
                        </span>
                      </span>
                    </span>
                    {option.recommended === true ? (
                      <span className="shrink-0 text-xs" style={{ color: "var(--ink-muted)" }}>
                        推奨
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {card.selectionMode !== "binary" ? (
          <div className="grid grid-cols-2 gap-1.5 pt-0.5">
            <div
              data-testid={isTop ? "outcome-decline" : undefined}
              className="rounded-xl border px-2.5 py-2 transition-colors"
              style={{
                backgroundColor:
                  direction === "left" ? "var(--tone-decline-bg)" : "var(--surface-subtle)",
                borderColor:
                  direction === "left" ? "var(--tone-decline-border)" : "var(--border-subtle)",
              }}
            >
              <div className="text-xs font-semibold" style={{ color: "var(--tone-decline)" }}>
                ← 全案見送り
              </div>
              <p className="mt-0.5 text-xs leading-snug" style={{ color: "var(--ink-muted)" }}>
                {card.declineEffect}
              </p>
            </div>
            <div
              data-testid={isTop ? "outcome-accept" : undefined}
              className="rounded-xl border px-2.5 py-2 transition-colors"
              style={{
                backgroundColor:
                  direction === "right" ? "var(--tone-accept-bg)" : "var(--surface-subtle)",
                borderColor:
                  direction === "right" ? "var(--tone-accept-border)" : "var(--border-subtle)",
              }}
            >
              <div className="text-xs font-semibold" style={{ color: "var(--tone-accept)" }}>
                確定すると →
              </div>
              <p className="mt-0.5 text-xs leading-snug" style={{ color: "var(--ink-muted)" }}>
                {card.acceptEffect}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer: Artifact Preview Trigger */}
      <div
        className="mt-2 flex items-center justify-between gap-2 border-t pt-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <button
          type="button"
          data-no-drag="true"
          data-testid={isTop ? "btn-open-detail" : undefined}
          onClick={onOpenDetail}
          className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-xl px-2 text-left transition-colors"
        >
          <span className="min-w-0">
            <span className="block text-xs" style={{ color: "var(--ink-muted)" }}>
              {card.artifact.kind}
            </span>
            <span className="block truncate text-xs font-semibold">{card.artifact.title}</span>
          </span>
          <span className="shrink-0 text-xs font-semibold" style={{ color: "var(--accent-link)" }}>
            詳細 ›
          </span>
        </button>
      </div>
    </article>
  );
}
