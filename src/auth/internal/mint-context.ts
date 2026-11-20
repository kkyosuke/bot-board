import {
  type BotChannelType,
  type OwnerContext,
  type StoredBotConnectionStatus,
  type VerifiedBotContext,
} from "@/auth/context";
import { OWNER_CONTEXT_BRAND, VERIFIED_BOT_CONTEXT_BRAND } from "@/auth/internal/brands";
import { type BotScope, DomainError } from "@/domain";

export interface OwnerSessionInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface D1BotVerificationInput {
  readonly botConnectionId: string;
  readonly workspaceId: string;
  readonly workspaceOwnerUserId: string;
  readonly isWorkspacePaused: boolean;
  readonly channelType: BotChannelType;
  readonly status: StoredBotConnectionStatus;
  readonly connectionScopes: readonly BotScope[];
  readonly connectionOAuthClientId?: string;
  readonly tokenClientId?: string;
  readonly tokenScopes?: readonly BotScope[];
  readonly tokenSubjectUserId?: string;
}

function createImmutableScopeSet(scopes: Iterable<BotScope>): ReadonlySet<BotScope> {
  const backing = new Set<BotScope>(scopes);

  const view: ReadonlySet<BotScope> = {
    get size(): number {
      return backing.size;
    },
    has(value: BotScope): boolean {
      return backing.has(value);
    },
    forEach(
      callbackfn: (value: BotScope, value2: BotScope, set: ReadonlySet<BotScope>) => void,
      thisArg?: unknown,
    ): void {
      for (const item of backing) {
        callbackfn.call(thisArg, item, item, view);
      }
    },
    entries(): SetIterator<[BotScope, BotScope]> {
      return backing.entries();
    },
    keys(): SetIterator<BotScope> {
      return backing.keys();
    },
    values(): SetIterator<BotScope> {
      return backing.values();
    },
    union<U>(other: ReadonlySetLike<U>): Set<BotScope | U> {
      return backing.union(other);
    },
    intersection<U>(other: ReadonlySetLike<U>): Set<BotScope & U> {
      return backing.intersection(other);
    },
    difference<U>(other: ReadonlySetLike<U>): Set<BotScope> {
      return backing.difference(other);
    },
    symmetricDifference<U>(other: ReadonlySetLike<U>): Set<BotScope | U> {
      return backing.symmetricDifference(other);
    },
    isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
      return backing.isSubsetOf(other);
    },
    isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
      return backing.isSupersetOf(other);
    },
    isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
      return backing.isDisjointFrom(other);
    },
    [Symbol.iterator](): SetIterator<BotScope> {
      return backing.values();
    },
  };

  return Object.freeze(view);
}

export function mintOwnerContext(input: OwnerSessionInput): OwnerContext {
  if (
    input.userId.trim() === "" ||
    input.workspaceId.trim() === "" ||
    input.sessionId.trim() === ""
  ) {
    throw new DomainError("NOT_AUTHORIZED", "Invalid owner session identity.", false);
  }

  return Object.freeze({
    [OWNER_CONTEXT_BRAND]: true as const,
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
}

export function mintVerifiedBotContext(input: D1BotVerificationInput): VerifiedBotContext {
  if (
    input.botConnectionId.trim() === "" ||
    input.workspaceId.trim() === "" ||
    input.workspaceOwnerUserId.trim() === ""
  ) {
    throw new DomainError("NOT_AUTHORIZED", "Invalid bot connection or workspace identity.", false);
  }

  if (input.status === "revoked") {
    throw new DomainError("NOT_AUTHORIZED", "Bot connection is revoked.", false);
  }

  if (input.channelType === "mcp_oauth") {
    if (
      input.tokenSubjectUserId === undefined ||
      input.tokenSubjectUserId.trim() === "" ||
      input.tokenSubjectUserId !== input.workspaceOwnerUserId
    ) {
      throw new DomainError("NOT_AUTHORIZED", "OAuth token owner mismatch.", false);
    }

    if (
      input.connectionOAuthClientId === undefined ||
      input.connectionOAuthClientId.trim() === "" ||
      input.tokenClientId === undefined ||
      input.tokenClientId !== input.connectionOAuthClientId
    ) {
      throw new DomainError("NOT_AUTHORIZED", "OAuth client_id mismatch.", false);
    }
  }

  const grantedSet = new Set<BotScope>(input.connectionScopes);
  const intersected =
    input.channelType === "mcp_oauth"
      ? (input.tokenScopes ?? []).filter((scope) => grantedSet.has(scope))
      : grantedSet;

  return Object.freeze({
    [VERIFIED_BOT_CONTEXT_BRAND]: true as const,
    botConnectionId: input.botConnectionId,
    workspaceId: input.workspaceId,
    channelType: input.channelType,
    status: input.status,
    isWorkspacePaused: input.isWorkspacePaused,
    effectiveScopes: createImmutableScopeSet(intersected),
  });
}
