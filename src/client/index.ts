import { ERROR_CODES, type ErrorCode } from "@/domain";

export const CLIENT_ROUTES = [
  "/",
  "/board",
  "/history",
  "/settings",
  "/sign-in",
  "/consent",
] as const;

export type ClientRoute = (typeof CLIENT_ROUTES)[number];

export function isKnownErrorCode(code: string): code is ErrorCode {
  return ERROR_CODES.some((entry) => entry === code);
}
