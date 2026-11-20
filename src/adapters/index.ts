export const WORKER_LLM_PROVIDERS = ["grok", "gemini", "meta-muse"] as const;

export type WorkerLlmProvider = (typeof WORKER_LLM_PROVIDERS)[number];

export function parseWorkerLlmProvider(raw: string): WorkerLlmProvider | null {
  const normalized = raw.trim().toLowerCase();
  return WORKER_LLM_PROVIDERS.find((provider) => provider === normalized) ?? null;
}

export {
  createGeminiModelAdapter,
  DEFAULT_GEMINI_CHAT_COMPLETIONS_URL,
  DEFAULT_GEMINI_MAX_COMPLETION_TOKENS,
  DEFAULT_GEMINI_MODEL,
  type GeminiAdapterConfig,
} from "./gemini";
export {
  createGrokModelAdapter,
  DEFAULT_GROK_MAX_COMPLETION_TOKENS,
  DEFAULT_GROK_MODEL,
  DEFAULT_XAI_CHAT_COMPLETIONS_URL,
  GROK_SYSTEM_PROMPT,
  type GrokAdapterConfig,
} from "./grok";
export {
  createMetaMuseModelAdapter,
  DEFAULT_META_MODEL_CHAT_COMPLETIONS_URL,
  DEFAULT_META_MUSE_MAX_COMPLETION_TOKENS,
  DEFAULT_META_MUSE_MODEL,
  type MetaMuseAdapterConfig,
} from "./meta-muse";
export {
  createLocalScenarioModelAdapter,
  createScriptedModelAdapter,
  type ScriptedStepHandler,
} from "./mock";
export {
  BOUNDED_WORKER_SYSTEM_PROMPT,
  createOpenAiCompatibleModelAdapter,
  DEFAULT_MAX_COMPLETION_TOKENS,
  type OpenAiCompatibleAdapterOptions,
  type OpenAiCompatibleReasoningEffort,
} from "./openai-compatible";
export {
  assertModelTimeoutWithinLease,
  type BoundedModelStepOptions,
  classifyHttpAdapterFailure,
  type ModelAdapter,
  ModelAdapterError,
  type ModelAdapterErrorCode,
  type ModelAdapterErrorKind,
  type ModelAdapterErrorOptions,
  type ModelStepArtifactSummary,
  type ModelStepContext,
  type ModelStepOutput,
  modelStepOutputSchema,
  type ModelStepTriggerDecision,
  parseRetryAfterHeader,
} from "./types";
