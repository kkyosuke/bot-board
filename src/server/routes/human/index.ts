import { type OwnerContext, type OwnerSessionInput, verifyOwnerSessionContext } from "@/auth/owner";
import { assertOwnerWorkspaceAccess } from "@/services/human";

export function authorizeHumanRoute(session: OwnerSessionInput, workspaceId: string): OwnerContext {
  const ctx = verifyOwnerSessionContext(session);
  assertOwnerWorkspaceAccess(ctx, workspaceId);
  return ctx;
}
