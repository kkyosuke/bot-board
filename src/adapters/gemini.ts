import {
  createOpenAiCompatibleModelAdapter,
  DEFAULT_MAX_COMPLETION_TOKENS,
} from "./openai-compatible";
import { type ModelAdapter } from "./types";

export const DEFAULT_GEMINI_CHAT_COMPLETIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_MAX_COMPLETION_TOKENS = DEFAULT_MAX_COMPLETION_TOKENS;

export interface GeminiAdapterConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createGeminiModelAdapter(config: GeminiAdapterConfig): ModelAdapter {
  const rawEndpoint = config.endpointUrl?.trim() ?? "";
  const rawModel = config.model?.trim() ?? "";
  const endpointUrl = rawEndpoint !== "" ? rawEndpoint : DEFAULT_GEMINI_CHAT_COMPLETIONS_URL;
  const model = rawModel !== "" ? rawModel : DEFAULT_GEMINI_MODEL;

  return createOpenAiCompatibleModelAdapter({
    adapterNamePrefix: "google-gemini",
    providerLabel: "Google Gemini API",
    missingKeyEnvName: "GEMINI_API_KEY",
    apiKey: config.apiKey,
    endpointUrl,
    model,
    maxCompletionTokens: DEFAULT_GEMINI_MAX_COMPLETION_TOKENS,
    // Gemini 3.5+ / 3.6+ / 4 deprecate sampling parameters (temperature/top_p/top_k); omit temperature.
    // OpenAI-compatible reasoning_effort="low" maps to thinking_level="low" / thinking_budget=1024.
    reasoningEffort: "low",
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });
}
