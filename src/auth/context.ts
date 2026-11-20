import { type OWNER_CONTEXT_BRAND, type VERIFIED_BOT_CONTEXT_BRAND } from "@/auth/internal/brands";
import { type BotScope } from "@/domain";

export type ActiveBotConnectionStatus = "active" | "paused";
export type StoredBotConnectionStatus = ActiveBotConnectionStatus | "revoked";
export type BotChannelType = "mcp_oauth" | "worker_bearer";

export interface OwnerContext {
  readonly [OWNER_CONTEXT_BRAND]: true;
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface VerifiedBotContext {
  readonly [VERIFIED_BOT_CONTEXT_BRAND]: true;
  readonly botConnectionId: string;
  readonly workspaceId: string;
  readonly channelType: BotChannelType;
  readonly status: ActiveBotConnectionStatus;
  readonly isWorkspacePaused: boolean;
  readonly effectiveScopes: ReadonlySet<BotScope>;
}
