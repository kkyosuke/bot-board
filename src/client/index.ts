import { ERROR_CODES, type ErrorCode } from "@/domain";

export { App, type AppProps } from "./App";
export {
  ClientTransportError,
  type DecideCardInput,
  type DecisionCardClient,
  type DecisionQueueSnapshot,
  type DeferCardInput,
  type DeferCardReceipt,
  type ProvisionalDecisionReceipt,
  type UndoCardInput,
  type UndoCardReceipt,
} from "./api/decision-client";
export { createInitialDecisionCards } from "./api/fixtures";
export {
  createMockDecisionClient,
  type MockDecisionClientOptions,
} from "./api/mock-decision-client";

export {
  type AppRoute,
  buildSignInRedirectPath,
  isSafeRedirectUrl,
  normalizeSafeNextPath,
  parseAppRoute,
} from "./router";

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
