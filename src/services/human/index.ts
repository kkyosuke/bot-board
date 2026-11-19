import { type OwnerContext } from "@/auth/context";
import { didParentMutationApply, type GuardedMutationOutcome } from "@/db";
import { DomainError } from "@/domain";

export function assertOwnerWorkspaceAccess(ctx: OwnerContext, targetWorkspaceId: string): void {
  if (ctx.workspaceId !== targetWorkspaceId) {
    throw new DomainError("NOT_AUTHORIZED", "Workspace ownership mismatch.", false);
  }
}

export function verifyHumanMutationOutcome(parentChanges: number): GuardedMutationOutcome {
  return didParentMutationApply(parentChanges);
}
