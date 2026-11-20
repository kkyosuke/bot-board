import { z } from "zod";

import {
  CARD_TYPES,
  DomainError,
  ON_DECLINE_POLICIES,
  SELECTION_MODES,
  TASK_STATUSES,
  type TaskStatus,
} from "@/domain";

export interface BoundedModelStepOptions {
  readonly timeoutMs: number;
  readonly leaseRemainingMs: number;
}

export function assertModelTimeoutWithinLease(options: BoundedModelStepOptions): void {
  if (
    !Number.isFinite(options.timeoutMs) ||
    !Number.isFinite(options.leaseRemainingMs) ||
    options.timeoutMs <= 0 ||
    options.leaseRemainingMs <= 0
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Timeout and lease duration must be positive.",
      false,
    );
  }
  if (options.timeoutMs >= options.leaseRemainingMs) {
    throw new DomainError(
      "LEASE_CONFLICT",
      "Model step timeout must be strictly shorter than remaining WorkLease TTL.",
      true,
    );
  }
}

export type ModelAdapterErrorKind = "retryable" | "permanent";

export type ModelAdapterErrorCode =
  | "RATE_LIMITED"
  | "UPSTREAM_5XX"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "AUTH_ERROR"
  | "BAD_REQUEST"
  | "SCHEMA_INVALID"
  | "MISSING_API_KEY";

export interface ModelAdapterErrorOptions {
  readonly retryAfterSeconds?: number;
  readonly httpStatus?: number;
}

export class ModelAdapterError extends Error {
  public readonly kind: ModelAdapterErrorKind;
  public readonly reasonCode: ModelAdapterErrorCode;
  public readonly retryAfterSeconds?: number;
  public readonly httpStatus?: number;

  public constructor(
    kind: ModelAdapterErrorKind,
    reasonCode: ModelAdapterErrorCode,
    message: string,
    options?: ModelAdapterErrorOptions,
  ) {
    super(message);
    this.name = "ModelAdapterError";
    this.kind = kind;
    this.reasonCode = reasonCode;
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    if (options?.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
  }
}

export function parseRetryAfterHeader(rawHeader: string | null | undefined): number | undefined {
  if (rawHeader === null || rawHeader === undefined) {
    return undefined;
  }
  const trimmed = rawHeader.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(300, Math.max(1, secs));
    }
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const diffSecs = Math.ceil((parsedDate - Date.now()) / 1000);
    if (diffSecs > 0) {
      return Math.min(300, Math.max(1, diffSecs));
    }
  }
  return undefined;
}

export function classifyHttpAdapterFailure(
  status: number,
  providerLabel: string,
  retryAfterHeader?: string | null,
): ModelAdapterError {
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterHeader(retryAfterHeader) ?? 15;
    return new ModelAdapterError(
      "retryable",
      "RATE_LIMITED",
      `${providerLabel} rate limit exceeded (HTTP 429).`,
      { httpStatus: status, retryAfterSeconds },
    );
  }
  if (status === 408 || status >= 500) {
    return new ModelAdapterError(
      "retryable",
      "UPSTREAM_5XX",
      `${providerLabel} temporary upstream failure (HTTP ${status}).`,
      { httpStatus: status, retryAfterSeconds: 10 },
    );
  }
  if (status === 401 || status === 403) {
    return new ModelAdapterError(
      "permanent",
      "AUTH_ERROR",
      `${providerLabel} authentication or authorization failed (HTTP ${status}).`,
      { httpStatus: status },
    );
  }
  return new ModelAdapterError(
    "permanent",
    "BAD_REQUEST",
    `${providerLabel} rejected request payload (HTTP ${status}).`,
    { httpStatus: status },
  );
}

export interface ModelStepArtifactSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly version: number;
}

export interface ModelStepTriggerDecision {
  readonly id: string;
  readonly result: "accepted" | "declined";
  readonly proposalTitle: string;
  readonly cardType: (typeof CARD_TYPES)[number];
  readonly selectionMode: (typeof SELECTION_MODES)[number];
  readonly selectedOptionIds: readonly string[];
}

export interface ModelStepContext {
  readonly workspaceGoal: string;
  readonly allowedScope: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly status: TaskStatus;
    readonly requiresApproval: boolean;
    readonly version: number;
    readonly retryCount: number;
  };
  readonly latestArtifacts: readonly ModelStepArtifactSummary[];
  readonly triggerDecision?: ModelStepTriggerDecision;
}

const adapterArtifactSchema = z
  .object({
    id: z.string().trim().min(1).max(128).optional(),
    expected_version: z.number().int().min(1).optional(),
    title: z.string().trim().min(1).max(160),
    kind: z.string().trim().min(1).max(64),
    summary: z.string().trim().min(1).max(1000),
    content_or_url: z.string().trim().min(1).max(100_000),
  })
  .strict()
  .superRefine((art, ctx) => {
    if (art.id !== undefined && art.expected_version === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expected_version"],
        message: "expected_version is required when updating an existing artifact by id.",
      });
    }
  });

const adapterFactorSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

const adapterOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(120),
    badge: z.string().trim().min(1).max(40).optional(),
    summary: z.string().trim().min(1).max(300),
    meta: z.string().trim().min(1).max(120),
    recommended: z.boolean().optional(),
  })
  .strict();

const adapterProposalItemSchema = z
  .object({
    card_type: z.enum(CARD_TYPES),
    selection_mode: z.enum(SELECTION_MODES).default("binary"),
    options: z.array(adapterOptionSchema).max(12).optional(),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1000),
    on_accept_effect: z.string().trim().min(1).max(300),
    on_decline_effect: z.string().trim().min(1).max(300),
    on_decline_policy: z.enum(ON_DECLINE_POLICIES).default("revise"),
    factors: z.array(adapterFactorSchema).max(8).default([]),
    target_artifact_id: z.string().trim().min(1).max(128).optional(),
    expires_in_seconds: z.number().int().min(60).max(2_592_000).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const options = item.options ?? [];
    if (item.selection_mode === "binary") {
      if (options.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: 'Binary proposals must not include "options".',
        });
      }
      return;
    }

    if (options.length < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `Selection mode "${item.selection_mode}" requires at least 2 options.`,
      });
      return;
    }

    const seen = new Set<string>();
    for (let i = 0; i < options.length; i += 1) {
      const opt = options[i];
      if (opt === undefined) {
        continue;
      }
      if (seen.has(opt.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["options", i, "id"],
          message: `Duplicate option id "${opt.id}".`,
        });
      }
      seen.add(opt.id);
    }
  });

const adapterSubtaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    requires_approval: z.boolean().default(true),
  })
  .strict();

export const modelStepOutputSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("submit_proposal"),
        selection_group_id: z.string().trim().min(1).max(128).optional(),
        artifact: adapterArtifactSchema.optional(),
        proposals: z.array(adapterProposalItemSchema).min(1).max(5),
        estimated_cost_cents: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    z
      .object({
        action: z.literal("record_result"),
        outcome: z.enum(["success", "failed"]),
        summary: z.string().trim().max(2000).optional(),
        status_reason: z.string().trim().max(500).optional(),
        artifact: adapterArtifactSchema.optional(),
        estimated_cost_cents: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    z
      .object({
        action: z.literal("update_task"),
        status: z.enum(["ready", "blocked"]),
        description: z.string().max(4000).optional(),
        status_reason: z.string().trim().max(500).optional(),
        artifact: adapterArtifactSchema.optional(),
        subtasks: z.array(adapterSubtaskSchema).max(5).optional(),
        estimated_cost_cents: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
  ])
  .superRefine((output, ctx) => {
    if (output.action === "submit_proposal" && output.proposals.length > 1) {
      const firstPolicy = output.proposals[0]?.on_decline_policy;
      for (let i = 1; i < output.proposals.length; i += 1) {
        if (output.proposals[i]?.on_decline_policy !== firstPolicy) {
          ctx.addIssue({
            code: "custom",
            path: ["proposals", i, "on_decline_policy"],
            message: "All proposals in a batch must share the same on_decline_policy.",
          });
        }
      }
    }
  });

export type ModelStepOutput = z.infer<typeof modelStepOutputSchema>;

export const TASK_STATUS_LIST = TASK_STATUSES;

export interface ModelAdapter {
  readonly name: string;
  executeStep(
    context: ModelStepContext,
    options: BoundedModelStepOptions,
  ): Promise<ModelStepOutput>;
}
