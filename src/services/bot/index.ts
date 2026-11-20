import { type VerifiedBotContext } from "@/auth/context";
import { didParentMutationApply, type GuardedMutationOutcome } from "@/db";
import { type BotScope, DomainError } from "@/domain";

export function assertBotReadScope(
  ctx: VerifiedBotContext,
  targetWorkspaceId: string,
  requiredScope: BotScope,
): void {
  if (ctx.workspaceId !== targetWorkspaceId) {
    throw new DomainError("NOT_AUTHORIZED", "Cross-workspace access denied.", false);
  }
  if (!ctx.effectiveScopes.has(requiredScope)) {
    throw new DomainError("NOT_AUTHORIZED", `Missing required scope: ${requiredScope}.`, false);
  }
}

export function assertBotWriteAccess(
  ctx: VerifiedBotContext,
  targetWorkspaceId: string,
  requiredScope: BotScope,
): void {
  assertBotReadScope(ctx, targetWorkspaceId, requiredScope);

  if (ctx.isWorkspacePaused) {
    throw new DomainError("WORKSPACE_PAUSED", "Workspace is currently paused.", true);
  }
  if (ctx.status === "paused") {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "Bot connection is paused for write operations.",
      false,
    );
  }
}

export function verifyBotMutationOutcome(parentChanges: number): GuardedMutationOutcome {
  return didParentMutationApply(parentChanges);
}
