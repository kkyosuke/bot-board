import { z } from "zod";

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
          content: z.string(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).optional(),
      completion_tokens: z.number().int().min(0).optional(),
      total_tokens: z.number().int().min(0).optional(),
    })
    .optional(),
});

const GROK_SYSTEM_PROMPT = [
  "You are a bounded autonomous worker step for bot-board.",
  "Never assume authority to approve human decision cards or execute external side effects.",
  "Return ONLY a single valid JSON object matching one of 3 actions:",
  '1) {"action":"submit_proposal","artifact"?:{...},"proposals":[...],"estimated_cost_cents":number}',
  '2) {"action":"record_result","outcome":"success"|"failed","summary"?:string,"status_reason"?:string,"artifact"?:{...},"estimated_cost_cents":number}',
  '3) {"action":"update_task","status":"ready"|"blocked","description"?:string,"status_reason"?:string,"artifact"?:{...},"subtasks"?:[...],"estimated_cost_cents":number}',
  "If task.requires_approval is true, NEVER return record_result(outcome='success'); instead submit a deliverable proposal with submit_proposal.",
].join("\n");

function estimateCostCentsFromUsage(
  usage:
    | {
        readonly prompt_tokens?: number | undefined;
        readonly completion_tokens?: number | undefined;
        readonly total_tokens?: number | undefined;
      }
    | undefined,
): number {
  if (
    usage === undefined ||
    (usage.total_tokens === undefined &&
      usage.prompt_tokens === undefined &&
      usage.completion_tokens === undefined)
  ) {
    return 1;
  }
  const totalTokens =
    usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
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

      let response: Response;
      try {
        response = await fetchFn(endpointUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${trimmedKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: GROK_SYSTEM_PROMPT },
              { role: "user", content: buildSanitizedUserPayload(context) },
            ],
          }),
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
          "xAI Grok API response envelope did not match expected chat completions schema.",
        );
      }

      const contentText = envelope.data.choices[0]?.message.content ?? "";
      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(contentText);
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
          "xAI Grok model step output violated bounded step schema.",
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
