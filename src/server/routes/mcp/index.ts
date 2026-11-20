import {
  type D1BotVerificationInput,
  type VerifiedBotContext,
  verifyBotConnectionContext,
} from "@/auth/bot";
import { type BotScope } from "@/domain";
import { assertBotReadScope, assertBotWriteAccess } from "@/services/bot";

export function authorizeMcpToolCall(
  record: D1BotVerificationInput,
  requiredScope: BotScope,
  mode: "read" | "write",
): VerifiedBotContext {
  const ctx = verifyBotConnectionContext(record);
  if (mode === "write") {
    assertBotWriteAccess(ctx, record.workspaceId, requiredScope);
  } else {
    assertBotReadScope(ctx, record.workspaceId, requiredScope);
  }
  return ctx;
}
