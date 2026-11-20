import {
  createOpenAiCompatibleModelAdapter,
  DEFAULT_MAX_COMPLETION_TOKENS,
} from "./openai-compatible";
import { type ModelAdapter } from "./types";

export const DEFAULT_META_MODEL_CHAT_COMPLETIONS_URL = "https://api.meta.ai/v1/chat/completions";
export const DEFAULT_META_MUSE_MODEL = "muse-spark-1.3";
export const DEFAULT_META_MUSE_MAX_COMPLETION_TOKENS = DEFAULT_MAX_COMPLETION_TOKENS;

export interface MetaMuseAdapterConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createMetaMuseModelAdapter(config: MetaMuseAdapterConfig): ModelAdapter {
  const rawEndpoint = config.endpointUrl?.trim() ?? "";
  const rawModel = config.model?.trim() ?? "";
  const endpointUrl = rawEndpoint !== "" ? rawEndpoint : DEFAULT_META_MODEL_CHAT_COMPLETIONS_URL;
  const model = rawModel !== "" ? rawModel : DEFAULT_META_MUSE_MODEL;

  return createOpenAiCompatibleModelAdapter({
    adapterNamePrefix: "meta-muse",
    providerLabel: "Meta Model API",
    missingKeyEnvName: "META_MODEL_API_KEY",
    apiKey: config.apiKey,
    endpointUrl,
    model,
    maxCompletionTokens: DEFAULT_META_MUSE_MAX_COMPLETION_TOKENS,
    // Meta Model API recommends keeping default temperature (1.0) on Muse Spark and rejects reasoning_effort="none" (400).
    reasoningEffort: "low",
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });
}
