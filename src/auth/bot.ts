import { type VerifiedBotContext } from "@/auth/context";
import { type D1BotVerificationInput, mintVerifiedBotContext } from "@/auth/internal/mint-context";

export type { D1BotVerificationInput, VerifiedBotContext };

export function verifyBotConnectionContext(record: D1BotVerificationInput): VerifiedBotContext {
  return mintVerifiedBotContext(record);
}
