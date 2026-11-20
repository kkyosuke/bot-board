import { useCallback, useEffect, useState } from "react";

export type AppRoute = "/" | "/board" | "/history" | "/settings" | "/sign-in" | "/consent";

export interface SpaLocation {
  readonly route: AppRoute;
  readonly pathname: string;
  readonly search: string;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function parseAppRoute(pathname: string): AppRoute {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (
    normalized === "/" ||
    normalized === "/board" ||
    normalized === "/history" ||
    normalized === "/settings" ||
    normalized === "/sign-in" ||
    normalized === "/consent"
  ) {
    return normalized;
  }
  return "/";
}

/**
 * Validates internal SPA redirect targets to prevent open-redirect attacks.
 * Only same-origin relative paths beginning with a single "/" (both before and after
 * URL dot-segment normalization) are permitted.
 */
export function normalizeSafeNextPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return "/";
  }
  const trimmed = raw.trim();
  if (
    trimmed === "" ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    hasControlChars(trimmed)
  ) {
    return "/";
  }
  try {
    const parsed = new URL(trimmed, "https://bot-board.local");
    if (
      parsed.origin !== "https://bot-board.local" ||
      !parsed.pathname.startsWith("/") ||
      parsed.pathname.startsWith("//")
    ) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

/**
 * Shared 401 -> /sign-in?next=... redirect builder used across S4 (/consent) and S6 (Human API).
 */
export function buildSignInRedirectPath(currentPathWithSearch: string): string {
  const safeNext = normalizeSafeNextPath(currentPathWithSearch);
  if (safeNext === "/" || safeNext.startsWith("/sign-in")) {
    return "/sign-in";
  }
  return `/sign-in?next=${encodeURIComponent(safeNext)}`;
}

/**
 * Validates an external OAuth callback redirect URL or same-origin relative path
 * returned by Better Auth before assigning window.location, forbidding javascript:/data:
 * schemes, backslashes, control characters, and dot-segment protocol-relative collapses.
 */
export function isSafeRedirectUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (trimmed === "" || hasControlChars(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//") || trimmed.includes("\\")) {
      return false;
    }
    try {
      const parsed = new URL(trimmed, "https://bot-board.local");
      return (
        parsed.origin === "https://bot-board.local" &&
        parsed.pathname.startsWith("/") &&
        !parsed.pathname.startsWith("//")
      );
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function readCurrentLocation(): SpaLocation {
  if (typeof window === "undefined") {
    return { route: "/", pathname: "/", search: "" };
  }
  const pathname = window.location.pathname || "/";
  const search = window.location.search || "";
  return {
    route: parseAppRoute(pathname),
    pathname,
    search,
  };
}

export function useSpaRouter(): {
  readonly location: SpaLocation;
  readonly navigate: (to: string, options?: { readonly replace?: boolean }) => void;
} {
  const [location, setLocation] = useState<SpaLocation>(() => readCurrentLocation());

  useEffect(() => {
    const handlePopState = (): void => {
      setLocation(readCurrentLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const navigate = useCallback((to: string, options?: { readonly replace?: boolean }): void => {
    if (typeof window === "undefined") {
      return;
    }
    const safeTarget = normalizeSafeNextPath(to);
    if (options?.replace === true) {
      window.history.replaceState(null, "", safeTarget);
    } else {
      window.history.pushState(null, "", safeTarget);
    }
    setLocation(readCurrentLocation());
  }, []);

  return { location, navigate };
}
