import { type ReactElement, type ReactNode, useEffect, useId, useRef } from "react";

export interface SheetModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly testId?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function SheetModal(props: SheetModalProps): ReactElement | null {
  const { open, title, testId, onClose, children } = props;
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef<() => void>(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-end justify-center p-2 sm:items-center sm:p-4"
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0"
        style={{ backgroundColor: "rgba(18, 18, 17, 0.48)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bb-card-shadow relative z-10 flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border"
        style={{
          backgroundColor: "var(--surface-card)",
          borderColor: "var(--border-default)",
        }}
      >
        <div
          className="flex items-center justify-between gap-2 border-b px-4 py-3"
          style={{ borderColor: "var(--border-default)" }}
        >
          <h2 id={titleId} className="truncate text-sm font-bold">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="btn-close-sheet"
            onClick={onClose}
            aria-label="閉じる"
            className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl"
            style={{ color: "var(--ink-muted)" }}
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4 text-sm">{children}</div>
      </div>
    </div>
  );
}
