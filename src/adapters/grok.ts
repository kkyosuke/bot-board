import {
  BOUNDED_WORKER_SYSTEM_PROMPT,
  createOpenAiCompatibleModelAdapter,
  DEFAULT_MAX_COMPLETION_TOKENS,
} from "./openai-compatible";
import { type ModelAdapter } from "./types";

export const DEFAULT_XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
export const DEFAULT_GROK_MODEL = "grok-3-mini";
export const DEFAULT_GROK_MAX_COMPLETION_TOKENS = DEFAULT_MAX_COMPLETION_TOKENS;
export const GROK_SYSTEM_PROMPT = BOUNDED_WORKER_SYSTEM_PROMPT;

export interface GrokAdapterConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createGrokModelAdapter(config: GrokAdapterConfig): ModelAdapter {
  const rawEndpoint = config.endpointUrl?.trim() ?? "";
  const rawModel = config.model?.trim() ?? "";
  const endpointUrl = rawEndpoint !== "" ? rawEndpoint : DEFAULT_XAI_CHAT_COMPLETIONS_URL;
  const model = rawModel !== "" ? rawModel : DEFAULT_GROK_MODEL;

  return createOpenAiCompatibleModelAdapter({
    adapterNamePrefix: "xai-grok",
    providerLabel: "xAI Grok API",
    missingKeyEnvName: "XAI_API_KEY",
    apiKey: config.apiKey,
    endpointUrl,
    model,
    maxCompletionTokens: DEFAULT_GROK_MAX_COMPLETION_TOKENS,
    temperature: 0.2,
    ...(model.startsWith("grok-3-mini") ? { reasoningEffort: "low" as const } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });
}
