import { z } from "zod";

import { CARD_TYPES, ON_DECLINE_POLICIES, SELECTION_MODES } from "@/domain";

import {
  assertModelTimeoutWithinLease,
  type BoundedModelStepOptions,
  classifyHttpAdapterFailure,
  type ModelAdapter,
  ModelAdapterError,
  type ModelStepContext,
  type ModelStepOutput,
  modelStepOutputSchema,
} from "./types";

export const DEFAULT_XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
export const DEFAULT_GROK_MODEL = "grok-3-mini";
export const DEFAULT_GROK_MAX_COMPLETION_TOKENS = 2048;

export interface GrokAdapterConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

const xaiChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).optional(),
      completion_tokens: z.number().int().min(0).optional(),
      total_tokens: z.number().int().min(0).optional(),
      completion_tokens_details: z
        .object({
          reasoning_tokens: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
});

const CARD_TYPES_ENUM_STR = CARD_TYPES.map((v) => JSON.stringify(v)).join("|");
const SELECTION_MODES_ENUM_STR = SELECTION_MODES.map((v) => JSON.stringify(v)).join("|");
const ON_DECLINE_POLICIES_ENUM_STR = ON_DECLINE_POLICIES.map((v) => JSON.stringify(v)).join("|");

export const GROK_SYSTEM_PROMPT = [
  "You are a bounded autonomous worker step for bot-board.",
  "Never assume authority to approve human decision cards or execute external side effects.",
  "Return ONLY a single valid JSON object (no markdown fences, no extra keys outside this contract).",
  "Every object uses strict validation: unknown keys are rejected, and estimated_cost_cents MUST be a non-negative integer.",
  "",
  "Shared nested object schemas:",
  '- artifact (optional): {"title":string(1..160),"kind":string(1..64),"summary":string(1..1000),"content_or_url":string(1..100000),"id"?:string,"expected_version"?:integer>=1}. If "id" is included, "expected_version" is REQUIRED.',
  '- factor: {"label":string(1..80),"value":string(1..200)}',
  '- option: {"id":string(1..64),"title":string(1..120),"summary":string(1..300),"meta":string(1..120),"badge"?:string(1..40),"recommended"?:boolean}',
  `- proposal: {"card_type":${CARD_TYPES_ENUM_STR},"selection_mode":${SELECTION_MODES_ENUM_STR},"title":string(1..160),"summary":string(1..1000),"on_accept_effect":string(1..300),"on_decline_effect":string(1..300),"on_decline_policy":${ON_DECLINE_POLICIES_ENUM_STR},"factors":factor[],"options"?:option[],"target_artifact_id"?:string,"expires_in_seconds"?:integer(60..2592000)}.`,
  '  Rules: if selection_mode is "binary", OMIT "options". If selection_mode is "single" or "multi", "options" MUST contain >=2 items with unique "id" values. If proposals.length > 1, every proposal MUST share the same on_decline_policy.',
  '- subtask: {"title":string(1..200),"description":string(0..4000),"requires_approval":boolean}',
  "",
  "Allowed top-level action objects (choose exactly ONE):",
  '1) {"action":"submit_proposal","selection_group_id"?:string,"artifact"?:artifact,"proposals":proposal[](1..5),"estimated_cost_cents":integer>=0}',
  '2) {"action":"record_result","outcome":"success"|"failed","summary"?:string(0..2000),"status_reason"?:string(0..500),"artifact"?:artifact,"estimated_cost_cents":integer>=0}',
  '3) {"action":"update_task","status":"ready"|"blocked","description"?:string(0..4000),"status_reason"?:string(0..500),"artifact"?:artifact,"subtasks"?:subtask[](0..5),"estimated_cost_cents":integer>=0}',
  "",
  'CRITICAL: If task.requires_approval is true, NEVER return {"action":"record_result","outcome":"success"}; submit a "deliverable" proposal using submit_proposal instead.',
].join("\n");

function stripJsonMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function formatSanitizedZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "$";
      return `${path}:${issue.code}`;
    })
    .join(", ");
}

function estimateCostCentsFromUsage(
  usage:
    | {
        readonly prompt_tokens?: number | undefined;
        readonly completion_tokens?: number | undefined;
        readonly total_tokens?: number | undefined;
        readonly completion_tokens_details?:
          | {
              readonly reasoning_tokens?: number | undefined;
            }
          | undefined;
      }
    | undefined,
): number {
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (
    usage === undefined ||
    (usage.total_tokens === undefined &&
      usage.prompt_tokens === undefined &&
      usage.completion_tokens === undefined &&
      reasoningTokens === 0)
  ) {
    return 1;
  }
  const summedParts = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) + reasoningTokens;
  const totalTokens = Math.max(usage.total_tokens ?? 0, summedParts);
  if (totalTokens <= 0) {
    return 0;
  }
  // Conservative upper-bound estimate in cents (~$1 / 1M tokens -> 1 cent per 10k tokens, min 1 cent when non-zero)
  return Math.max(1, Math.ceil(totalTokens / 10_000));
}

function buildSanitizedUserPayload(context: ModelStepContext): string {
  // Strictly send minimal task-only context (never secrets, tokens, or unrelated workspace records)
  return JSON.stringify({
    workspace_goal: context.workspaceGoal.slice(0, 1000),
    allowed_scope: context.allowedScope.slice(0, 1000),
    task: {
      id: context.task.id,
      title: context.task.title,
      description: context.task.description.slice(0, 4000),
      status: context.task.status,
      requires_approval: context.task.requiresApproval,
      version: context.task.version,
      retry_count: context.task.retryCount,
    },
    latest_artifacts: context.latestArtifacts.slice(0, 5).map((art) => ({
      id: art.id,
      title: art.title,
      kind: art.kind,
      summary: art.summary.slice(0, 400),
      version: art.version,
    })),
    ...(context.triggerDecision !== undefined
      ? {
          trigger_decision: {
            id: context.triggerDecision.id,
            result: context.triggerDecision.result,
            proposal_title: context.triggerDecision.proposalTitle,
            card_type: context.triggerDecision.cardType,
            selection_mode: context.triggerDecision.selectionMode,
            selected_option_ids: context.triggerDecision.selectedOptionIds,
          },
        }
      : {}),
  });
}

function isAbortOrTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  return false;
}

export function createGrokModelAdapter(config: GrokAdapterConfig): ModelAdapter {
  const trimmedKey = config.apiKey.trim();
  const endpointUrl = (config.endpointUrl ?? DEFAULT_XAI_CHAT_COMPLETIONS_URL).trim();
  const model = (config.model ?? DEFAULT_GROK_MODEL).trim();
  const fetchFn = config.fetchImpl ?? fetch;

  return {
    name: `xai-grok:${model}`,

    async executeStep(
      context: ModelStepContext,
      options: BoundedModelStepOptions,
    ): Promise<ModelStepOutput> {
      assertModelTimeoutWithinLease(options);

      if (trimmedKey === "") {
        throw new ModelAdapterError(
          "permanent",
          "MISSING_API_KEY",
          "XAI_API_KEY is not configured for Grok worker adapter.",
        );
      }

      const requestPayload = {
        model,
        temperature: 0.2,
        max_completion_tokens: DEFAULT_GROK_MAX_COMPLETION_TOKENS,
        ...(model.startsWith("grok-3-mini") ? { reasoning_effort: "low" } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: GROK_SYSTEM_PROMPT },
          { role: "user", content: buildSanitizedUserPayload(context) },
        ],
      };

      let response: Response;
      try {
        response = await fetchFn(endpointUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${trimmedKey}`,
          },
          body: JSON.stringify(requestPayload),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        if (isAbortOrTimeoutError(error)) {
          throw new ModelAdapterError(
            "retryable",
            "TIMEOUT",
            `xAI Grok request timed out after ${options.timeoutMs}ms.`,
            { retryAfterSeconds: 10 },
          );
        }
        throw new ModelAdapterError(
          "retryable",
          "NETWORK_ERROR",
          "xAI Grok request failed due to a transient network error.",
          { retryAfterSeconds: 10 },
        );
      }

      if (!response.ok) {
        const retryAfterHeader = response.headers.get("Retry-After");
        await response.body?.cancel().catch(() => undefined);
        throw classifyHttpAdapterFailure(response.status, "xAI Grok API", retryAfterHeader);
      }

      let rawBody: unknown;
      try {
        rawBody = await response.json();
      } catch (error) {
        if (isAbortOrTimeoutError(error)) {
          throw new ModelAdapterError(
            "retryable",
            "TIMEOUT",
            `xAI Grok response body timed out after ${options.timeoutMs}ms.`,
            { retryAfterSeconds: 10 },
          );
        }
        throw new ModelAdapterError(
          "permanent",
          "SCHEMA_INVALID",
          "xAI Grok API returned non-JSON response body.",
        );
      }

      const envelope = xaiChatResponseSchema.safeParse(rawBody);
      if (!envelope.success) {
        throw new ModelAdapterError(
          "permanent",
          "SCHEMA_INVALID",
          `xAI Grok API response envelope did not match expected chat completions schema (${formatSanitizedZodIssues(envelope.error.issues)}).`,
        );
      }

      const rawContent = envelope.data.choices[0]?.message.content;
      if (rawContent === null || rawContent === undefined || rawContent.trim() === "") {
        throw new ModelAdapterError(
          "permanent",
          "SCHEMA_INVALID",
          "xAI Grok API returned empty or null message content.",
        );
      }

      const cleanedContent = stripJsonMarkdownFence(rawContent);
      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(cleanedContent);
      } catch {
        throw new ModelAdapterError(
          "permanent",
          "SCHEMA_INVALID",
          "xAI Grok model output content was not valid JSON.",
        );
      }

      const stepResult = modelStepOutputSchema.safeParse(parsedContent);
      if (!stepResult.success) {
        throw new ModelAdapterError(
          "permanent",
          "SCHEMA_INVALID",
          `xAI Grok model step output violated bounded step schema (${formatSanitizedZodIssues(stepResult.error.issues)}).`,
        );
      }

      const usageFloorCents = estimateCostCentsFromUsage(envelope.data.usage);
      const effectiveCostCents = Math.max(stepResult.data.estimated_cost_cents, usageFloorCents);
      return {
        ...stepResult.data,
        estimated_cost_cents: effectiveCostCents,
      };
    },
  };
}
