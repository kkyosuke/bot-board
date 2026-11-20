import { z } from "zod";

import {
  BOT_SCOPES,
  type BotScope,
  type BudgetLimit,
  budgetLimitSchema,
  SELECTION_MODES,
  TASK_STATUSES,
  type TaskStatus,
} from "@/domain";

import { ClientTransportError } from "./decision-client";
import { parseHumanApiError } from "./http-decision-client";

const boardBotSummarySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  channel_type: z.enum(["mcp_oauth", "worker_bearer"]),
  status: z.enum(["active", "paused", "revoked"]),
  counts: z.object({
    running: z.number().int(),
    waiting_human: z.number().int(),
    failed: z.number().int(),
    blocked: z.number().int(),
    ready: z.number().int(),
    done: z.number().int(),
  }),
});

const boardTaskItemSchema = z.object({
  id: z.string(),
  parent_task_id: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  status_reason: z.string().nullable(),
  requires_approval: z.boolean(),
  assigned_bot_id: z.string().nullable(),
  assigned_bot_name: z.string().nullable(),
  retry_count: z.number().int(),
  version: z.number().int(),
  updated_at: z.number(),
  active_lease: z
    .object({
      bot_id: z.string(),
      expires_at: z.number(),
    })
    .nullable(),
});

const humanBoardResponseSchema = z.object({
  workspace: z.object({
    id: z.string(),
    is_paused: z.boolean(),
    version: z.number().int(),
  }),
  bots: z.array(boardBotSummarySchema),
  tasks: z.array(boardTaskItemSchema),
  columns: z.object({
    ready: z.array(boardTaskItemSchema),
    running: z.array(boardTaskItemSchema),
    waiting_human: z.array(boardTaskItemSchema),
    blocked: z.array(boardTaskItemSchema),
    failed: z.array(boardTaskItemSchema),
    done: z.array(boardTaskItemSchema),
  }),
});

const retryTaskResponseSchema = z.object({
  task_id: z.string(),
  version: z.number().int(),
  status: z.literal("ready"),
  trace_id: z.string(),
});

const historyItemSchema = z.object({
  decision_id: z.string(),
  card_id: z.string(),
  task_id: z.string(),
  task_title: z.string(),
  proposal_title: z.string(),
  selection_mode: z.enum(SELECTION_MODES),
  decision_result: z.enum(["accepted", "declined"]),
  selected_option_ids: z.array(z.string()),
  execution_status: z.enum(TASK_STATUSES),
  execution_reason: z.string().nullable(),
  bot_name: z.string(),
  artifact: z
    .object({
      id: z.string(),
      title: z.string(),
      version: z.number().int(),
    })
    .nullable(),
  finalized_at: z.number(),
});

const humanHistoryResponseSchema = z.object({
  items: z.array(historyItemSchema),
  next_cursor: z.string().nullable(),
});

const humanWorkspaceResponseSchema = z.object({
  id: z.string(),
  goal: z.string(),
  allowed_scope: z.string(),
  budget_limit: budgetLimitSchema,
  is_paused: z.boolean(),
  version: z.number().int(),
  updated_at: z.number(),
});

const humanBotConnectionSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  channel_type: z.enum(["mcp_oauth", "worker_bearer"]),
  oauth_client_id: z.string().nullable(),
  scopes: z.array(z.enum(BOT_SCOPES)),
  status: z.enum(["active", "paused", "revoked"]),
  version: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
});

const humanBotsListResponseSchema = z.object({
  items: z.array(humanBotConnectionSchema),
});

const createWorkerBotResponseSchema = z.object({
  bot_id: z.string(),
  display_name: z.string(),
  channel_type: z.literal("worker_bearer"),
  scopes: z.array(z.enum(BOT_SCOPES)),
  status: z.literal("active"),
  version: z.number().int(),
  bearer_token: z.string().nullable(),
  trace_id: z.string(),
});

const updateBotResponseSchema = z.object({
  bot_id: z.string(),
  display_name: z.string(),
  channel_type: z.enum(["mcp_oauth", "worker_bearer"]),
  scopes: z.array(z.enum(BOT_SCOPES)),
  status: z.enum(["active", "paused", "revoked"]),
  version: z.number().int(),
  trace_id: z.string(),
});

export type BoardBotSummaryDto = z.infer<typeof boardBotSummarySchema>;
export type BoardTaskItemDto = z.infer<typeof boardTaskItemSchema>;
export type HumanBoardDto = z.infer<typeof humanBoardResponseSchema>;
export type RetryTaskResponseDto = z.infer<typeof retryTaskResponseSchema>;
export type HistoryItemDto = z.infer<typeof historyItemSchema>;
export type HumanHistoryDto = z.infer<typeof humanHistoryResponseSchema>;
export type HumanWorkspaceDto = z.infer<typeof humanWorkspaceResponseSchema>;
export type HumanBotDto = z.infer<typeof humanBotConnectionSchema>;
export type CreateWorkerBotDto = z.infer<typeof createWorkerBotResponseSchema>;
export type UpdateBotDto = z.infer<typeof updateBotResponseSchema>;
export type HistoryFilterType = "all" | "accepted" | "declined" | "failed";

async function fetchHumanJson(path: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ClientTransportError(
      "サーバーとの通信に失敗しました。ネットワーク状態を確認して再試行してください。",
    );
  }
  if (!res.ok) {
    throw await parseHumanApiError(res);
  }
  try {
    return await res.json();
  } catch {
    throw new ClientTransportError(
      "サーバーから不正な応答を受信しました。しばらくして再試行してください。",
    );
  }
}

export function generateClientRequestId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${Date.now()}-${hex}`;
}

export async function fetchHumanBoard(): Promise<HumanBoardDto> {
  const raw = await fetchHumanJson("/api/human/board", { method: "GET" });
  return humanBoardResponseSchema.parse(raw);
}

export async function retryHumanTaskApi(
  taskId: string,
  input: { readonly requestId: string; readonly expectedVersion: number },
): Promise<RetryTaskResponseDto> {
  const raw = await fetchHumanJson(`/api/human/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: "POST",
    body: JSON.stringify({
      request_id: input.requestId,
      expected_version: input.expectedVersion,
    }),
  });
  return retryTaskResponseSchema.parse(raw);
}

export async function fetchHumanHistory(params: {
  readonly filter?: HistoryFilterType;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<HumanHistoryDto> {
  const query = new URLSearchParams();
  if (params.filter !== undefined) {
    query.set("filter", params.filter);
  }
  if (params.cursor !== undefined && params.cursor.trim() !== "") {
    query.set("cursor", params.cursor);
  }
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }
  const qs = query.toString();
  const raw = await fetchHumanJson(`/api/human/history${qs !== "" ? `?${qs}` : ""}`, {
    method: "GET",
  });
  return humanHistoryResponseSchema.parse(raw);
}

export async function fetchHumanWorkspace(): Promise<HumanWorkspaceDto> {
  const raw = await fetchHumanJson("/api/human/workspace", { method: "GET" });
  return humanWorkspaceResponseSchema.parse(raw);
}

export async function updateHumanWorkspaceApi(input: {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly goal?: string;
  readonly allowedScope?: string;
  readonly budgetLimit?: BudgetLimit;
  readonly isPaused?: boolean;
}): Promise<HumanWorkspaceDto> {
  const raw = await fetchHumanJson("/api/human/workspace", {
    method: "PATCH",
    body: JSON.stringify({
      request_id: input.requestId,
      expected_version: input.expectedVersion,
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.allowedScope !== undefined ? { allowed_scope: input.allowedScope } : {}),
      ...(input.budgetLimit !== undefined ? { budget_limit: input.budgetLimit } : {}),
      ...(input.isPaused !== undefined ? { is_paused: input.isPaused } : {}),
    }),
  });
  return humanWorkspaceResponseSchema.parse(raw);
}

export async function fetchHumanBots(): Promise<readonly HumanBotDto[]> {
  const raw = await fetchHumanJson("/api/human/bots", { method: "GET" });
  return humanBotsListResponseSchema.parse(raw).items;
}

export async function createHumanWorkerBotApi(input: {
  readonly requestId: string;
  readonly displayName: string;
  readonly scopes: readonly BotScope[];
}): Promise<CreateWorkerBotDto> {
  const raw = await fetchHumanJson("/api/human/bots", {
    method: "POST",
    body: JSON.stringify({
      request_id: input.requestId,
      display_name: input.displayName,
      scopes: [...input.scopes],
    }),
  });
  return createWorkerBotResponseSchema.parse(raw);
}

export async function updateHumanBotApi(
  botId: string,
  input: {
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly displayName?: string;
    readonly scopes?: readonly BotScope[];
    readonly status?: "active" | "paused" | "revoked";
  },
): Promise<UpdateBotDto> {
  const raw = await fetchHumanJson(`/api/human/bots/${encodeURIComponent(botId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      request_id: input.requestId,
      expected_version: input.expectedVersion,
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.scopes !== undefined ? { scopes: [...input.scopes] } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    }),
  });
  return updateBotResponseSchema.parse(raw);
}

export function formatTaskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "waiting_human":
      return "人判断待ち";
    case "running":
      return "Bot実行中";
    case "failed":
      return "実行失敗 (BOT-03)";
    case "blocked":
      return "停止/依存待ち";
    case "ready":
      return "待機中";
    case "done":
      return "完了";
  }
}
