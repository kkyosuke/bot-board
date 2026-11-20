import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type Hono } from "hono";

import {
  type D1BotVerificationInput,
  type VerifiedBotContext,
  verifyBotConnectionContext,
} from "@/auth/bot";
import { type BotScope, DomainError } from "@/domain";
import { mapErrorToHttpResponse } from "@/server/http-error";
import { enforceRateLimit, type RequestRateLimiter } from "@/server/rate-limit";
import {
  type ArtifactDetailDto,
  assertBotReadScope,
  assertBotWriteAccess,
  type ClaimTaskInput,
  claimTaskInputSchema,
  type ClaimTaskResult,
  type CreateTaskInput,
  createTaskInputSchema,
  type CreateTaskResult,
  type FinalizedDecisionResultDto,
  type GetArtifactInput,
  getArtifactInputSchema,
  type GetTaskInput,
  getTaskInputSchema,
  getWorkspaceContextInputSchema,
  type ListDecisionResultsInput,
  listDecisionResultsInputSchema,
  type ListTasksInput,
  listTasksInputSchema,
  type RecordResultInput,
  recordResultInputSchema,
  type RecordResultOutput,
  type RenewLeaseInput,
  renewLeaseInputSchema,
  type RenewLeaseResult,
  type SubmitProposalInput,
  submitProposalInputSchema,
  type SubmitProposalResult,
  type SupersedeProposalInput,
  supersedeProposalInputSchema,
  type SupersedeProposalResult,
  type TaskDetailDto,
  type TaskSummaryDto,
  type UpdateTaskInput,
  updateTaskInputSchema,
  type UpdateTaskResult,
  type WorkspaceContextDto,
} from "@/services/bot";

export const MCP_BOT_TOOL_NAMES = [
  "get_workspace_context",
  "list_tasks",
  "get_task",
  "get_artifact",
  "create_task",
  "claim_task",
  "renew_lease",
  "update_task",
  "submit_proposal",
  "supersede_proposal",
  "list_decision_results",
  "record_result",
] as const;

export type McpBotToolName = (typeof MCP_BOT_TOOL_NAMES)[number];

export interface McpBotServicePort {
  authenticate(authorizationHeader: string | null): Promise<VerifiedBotContext>;
  getWorkspaceContext(ctx: VerifiedBotContext): Promise<WorkspaceContextDto>;
  listTasks(
    ctx: VerifiedBotContext,
    input: ListTasksInput,
  ): Promise<{ readonly items: readonly TaskSummaryDto[]; readonly next_cursor: string | null }>;
  getTask(ctx: VerifiedBotContext, input: GetTaskInput): Promise<TaskDetailDto>;
  getArtifact(ctx: VerifiedBotContext, input: GetArtifactInput): Promise<ArtifactDetailDto>;
  createTask(ctx: VerifiedBotContext, input: CreateTaskInput): Promise<CreateTaskResult>;
  claimTask(ctx: VerifiedBotContext, input: ClaimTaskInput): Promise<ClaimTaskResult>;
  renewLease(ctx: VerifiedBotContext, input: RenewLeaseInput): Promise<RenewLeaseResult>;
  updateTask(ctx: VerifiedBotContext, input: UpdateTaskInput): Promise<UpdateTaskResult>;
  submitProposal(
    ctx: VerifiedBotContext,
    input: SubmitProposalInput,
  ): Promise<SubmitProposalResult>;
  supersedeProposal(
    ctx: VerifiedBotContext,
    input: SupersedeProposalInput,
  ): Promise<SupersedeProposalResult>;
  listDecisionResults(
    ctx: VerifiedBotContext,
    input: ListDecisionResultsInput,
  ): Promise<{
    readonly items: readonly FinalizedDecisionResultDto[];
    readonly next_cursor: string | null;
  }>;
  recordResult(ctx: VerifiedBotContext, input: RecordResultInput): Promise<RecordResultOutput>;
}

export interface McpRouteOptions {
  readonly port: McpBotServicePort;
  readonly rateLimiter?: RequestRateLimiter;
  readonly publicBaseUrl?: string;
}

export function authorizeMcpToolCall(
  record: D1BotVerificationInput,
  requiredScope: BotScope,
  accessMode: "read" | "write",
): VerifiedBotContext {
  const ctx = verifyBotConnectionContext(record);
  if (accessMode === "write") {
    assertBotWriteAccess(ctx, record.workspaceId, requiredScope);
  } else {
    assertBotReadScope(ctx, record.workspaceId, requiredScope);
  }
  return ctx;
}

async function runToolSafely(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
    };
  } catch (error) {
    const mapped = mapErrorToHttpResponse(error);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(mapped.body) }],
    };
  }
}

export function createBotMcpServer(port: McpBotServicePort, ctx: VerifiedBotContext): McpServer {
  const server = new McpServer({
    name: "bot-board",
    version: "1.0.0",
  });

  server.registerTool(
    "get_workspace_context",
    {
      title: "Get Workspace Context",
      description:
        "Read workspace goal, allowed scope, structured budget limits, pause state, and task status meanings from D1.",
      inputSchema: getWorkspaceContextInputSchema,
    },
    async () => await runToolSafely(() => port.getWorkspaceContext(ctx)),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "List tasks in the authorized workspace with cursor pagination.",
      inputSchema: listTasksInputSchema,
    },
    async (args) => await runToolSafely(() => port.listTasks(ctx, args)),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Get task detail, latest version, active lease ownership, artifact summaries, and decision cards.",
      inputSchema: getTaskInputSchema,
    },
    async (args) => await runToolSafely(() => port.getTask(ctx, args)),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Get Artifact",
      description: "Fetch the full content or URL of an artifact by ID.",
      inputSchema: getArtifactInputSchema,
    },
    async (args) => await runToolSafely(() => port.getArtifact(ctx, args)),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Create a new ready task in the authorized workspace (idempotent via request_id).",
      inputSchema: createTaskInputSchema,
    },
    async (args) => await runToolSafely(() => port.createTask(ctx, args)),
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim Task",
      description: "Acquire a time-bounded exclusive WorkLease on a ready task.",
      inputSchema: claimTaskInputSchema,
    },
    async (args) => await runToolSafely(() => port.claimTask(ctx, args)),
  );

  server.registerTool(
    "renew_lease",
    {
      title: "Renew Lease",
      description: "Extend the expiration time of an active WorkLease held by this Bot.",
      inputSchema: renewLeaseInputSchema,
    },
    async (args) => await runToolSafely(() => port.renewLease(ctx, args)),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description:
        "Update running task description, blocked/ready transition, or upsert an artifact under an active lease.",
      inputSchema: updateTaskInputSchema,
    },
    async (args) => await runToolSafely(() => port.updateTask(ctx, args)),
  );

  server.registerTool(
    "submit_proposal",
    {
      title: "Submit Proposal",
      description:
        "Submit 1..N decision cards (binary/single/multi) for human swipe review and release the WorkLease.",
      inputSchema: submitProposalInputSchema,
    },
    async (args) => await runToolSafely(() => port.submitProposal(ctx, args)),
  );

  server.registerTool(
    "supersede_proposal",
    {
      title: "Supersede Proposal",
      description:
        "Atomically replace a pending/deferred decision card with a newer card (rejected while provisional).",
      inputSchema: supersedeProposalInputSchema,
    },
    async (args) => await runToolSafely(() => port.supersedeProposal(ctx, args)),
  );

  server.registerTool(
    "list_decision_results",
    {
      title: "List Finalized Decision Results",
      description:
        "List strictly finalized human decisions (status='finalized' only; provisional decisions are never returned).",
      inputSchema: listDecisionResultsInputSchema,
    },
    async (args) => await runToolSafely(() => port.listDecisionResults(ctx, args)),
  );

  server.registerTool(
    "record_result",
    {
      title: "Record Result",
      description:
        "Record task execution result, optional artifact, failure reason, and consumed decision_id.",
      inputSchema: recordResultInputSchema,
    },
    async (args) => await runToolSafely(() => port.recordResult(ctx, args)),
  );

  return server;
}

function buildWwwAuthenticateHeader(requestUrl: string, publicBaseUrl?: string): string {
  const trimmedBase = publicBaseUrl?.trim() ?? "";
  const origin = trimmedBase !== "" ? trimmedBase.replace(/\/+$/, "") : new URL(requestUrl).origin;
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

function deriveRateLimitKey(req: Request): string {
  // Trust ONLY Cloudflare edge-injected cf-connecting-ip; never read spoofable X-Forwarded-For
  const cfIp = req.headers.get("cf-connecting-ip")?.trim() ?? "";
  return cfIp !== "" ? `mcp:ip:${cfIp}` : "mcp:ip:no-cf-ip";
}

export function mountMcpRoutes(app: Hono, options: McpRouteOptions): void {
  const handleMcp = async (c: {
    readonly req: { readonly raw: Request; header(name: string): string | undefined };
  }): Promise<Response> => {
    await enforceRateLimit(options.rateLimiter, deriveRateLimitKey(c.req.raw));

    let botCtx: VerifiedBotContext;
    try {
      botCtx = await options.port.authenticate(c.req.header("authorization") ?? null);
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_AUTHORIZED") {
        return new Response(
          JSON.stringify({
            code: "NOT_AUTHORIZED",
            message: error.message,
            retryable: false,
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": buildWwwAuthenticateHeader(c.req.raw.url, options.publicBaseUrl),
            },
          },
        );
      }
      throw error;
    }

    await enforceRateLimit(options.rateLimiter, `mcp:bot:${botCtx.botConnectionId}`);

    const mcpHandler = createMcpHandler(() => createBotMcpServer(options.port, botCtx));
    return await mcpHandler.fetch(c.req.raw);
  };

  app.post("/api/mcp", handleMcp);
  app.get("/api/mcp", handleMcp);
  app.delete("/api/mcp", handleMcp);
}
