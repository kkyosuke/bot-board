import { authenticateBotRequest, type OAuthJwtVerifier } from "@/auth/bot";
import { type AppDatabase } from "@/db";
import { type McpBotServicePort } from "@/server/routes/mcp";
import {
  claimTask,
  createTask,
  getArtifact,
  getTask,
  getWorkspaceContext,
  listDecisionResults,
  listTasks,
  recordResult,
  renewLease,
  submitProposal,
  supersedeProposal,
  updateTask,
} from "@/services/bot";

export interface CreateMcpBotPortOptions {
  readonly verifyOAuthJwt?: OAuthJwtVerifier;
  readonly now?: () => number;
}

export function createMcpBotServicePort(
  db: AppDatabase,
  options: CreateMcpBotPortOptions = {},
): McpBotServicePort {
  const nowFn = options.now ?? (() => Date.now());

  return {
    authenticate(authorizationHeader) {
      return authenticateBotRequest({
        db,
        authorizationHeader,
        ...(options.verifyOAuthJwt !== undefined ? { verifyOAuthJwt: options.verifyOAuthJwt } : {}),
        nowMs: nowFn(),
      });
    },
    getWorkspaceContext(ctx) {
      return getWorkspaceContext(db, ctx);
    },
    listTasks(ctx, input) {
      return listTasks(db, ctx, input);
    },
    getTask(ctx, input) {
      return getTask(db, ctx, input, nowFn());
    },
    getArtifact(ctx, input) {
      return getArtifact(db, ctx, input);
    },
    createTask(ctx, input) {
      return createTask(db, ctx, input, nowFn());
    },
    claimTask(ctx, input) {
      return claimTask(db, ctx, input, nowFn());
    },
    renewLease(ctx, input) {
      return renewLease(db, ctx, input, nowFn());
    },
    updateTask(ctx, input) {
      return updateTask(db, ctx, input, nowFn());
    },
    submitProposal(ctx, input) {
      return submitProposal(db, ctx, input, nowFn());
    },
    supersedeProposal(ctx, input) {
      return supersedeProposal(db, ctx, input, nowFn());
    },
    listDecisionResults(ctx, input) {
      return listDecisionResults(db, ctx, input);
    },
    recordResult(ctx, input) {
      return recordResult(db, ctx, input, nowFn());
    },
  };
}
