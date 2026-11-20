import { type OwnerContext } from "@/auth/context";
import { mintOwnerContext, type OwnerSessionInput } from "@/auth/internal/mint-context";

export type { OwnerContext, OwnerSessionInput };

export function verifyOwnerSessionContext(session: OwnerSessionInput): OwnerContext {
  return mintOwnerContext(session);
}
