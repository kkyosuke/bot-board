import { type ReactElement } from "react";

export type NavTabId = "decide" | "board" | "history" | "settings";

export interface BottomNavProps {
  readonly activeTab: NavTabId;
  readonly onSelectTab: (tab: NavTabId) => void;
}

export function BottomNav(props: BottomNavProps): ReactElement {
  const { activeTab, onSelectTab } = props;

  const items: ReadonlyArray<{
    readonly id: NavTabId;
    readonly label: string;
    readonly icon: ReactElement;
  }> = [
    {
      id: "decide",
      label: "判断",
      icon: (
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      ),
    },
    {
      id: "board",
      label: "状況",
      icon: (
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="5" height="16" rx="1" />
          <rect x="10" y="4" width="5" height="11" rx="1" />
          <rect x="17" y="4" width="4" height="14" rx="1" />
        </svg>
      ),
    },
    {
      id: "history",
      label: "履歴",
      icon: (
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 16 14" />
        </svg>
      ),
    },
    {
      id: "settings",
      label: "設定",
      icon: (
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
        </svg>
      ),
    },
  ];

  return (
    <nav
      aria-label="メインナビゲーション"
      className="mt-4 grid grid-cols-4 gap-1 border-t pt-2 text-xs"
      style={{ borderColor: "var(--border-default)" }}
    >
      {items.map((item) => {
        const isActive = item.id === activeTab;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`nav-${item.id}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelectTab(item.id)}
            className="flex min-h-[44px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border transition-colors"
            style={{
              backgroundColor: isActive ? "var(--surface-card)" : "transparent",
              borderColor: isActive ? "var(--border-default)" : "transparent",
              color: isActive ? "var(--ink-primary)" : "var(--ink-muted)",
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
