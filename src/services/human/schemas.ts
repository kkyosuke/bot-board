import { z } from "zod";

import { BOT_SCOPES, budgetLimitSchema } from "@/domain";

export const humanRequestIdSchema = z.string().trim().min(1).max(128);
export const humanPositiveVersionSchema = z.number().int().min(1);
export const humanNonEmptyIdSchema = z.string().trim().min(1).max(128);

export const decisionPayloadSchema = z.union([
  z
    .object({
      mode: z.literal("binary"),
      decision: z.enum(["accepted", "declined"]),
    })
    .strict(),
  z
    .object({
      mode: z.literal("single"),
      decision: z.literal("accepted"),
      selectedOptionId: z.string().trim().min(1).max(64),
    })
    .strict(),
  z
    .object({
      mode: z.literal("single"),
      decision: z.literal("declined"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("multi"),
      decision: z.literal("accepted"),
      acceptedOptionIds: z.array(z.string().trim().min(1).max(64)),
      declinedOptionIds: z.array(z.string().trim().min(1).max(64)),
    })
    .strict(),
  z
    .object({
      mode: z.literal("multi"),
      decision: z.literal("declined"),
      acceptedOptionIds: z.tuple([]),
      declinedOptionIds: z.array(z.string().trim().min(1).max(64)),
    })
    .strict(),
]);

export const listHumanCardsQuerySchema = z
  .object({
    status: z.enum(["all", "pending", "deferred"]).default("all"),
  })
  .strict();

export const decideHumanCardInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    expected_version: humanPositiveVersionSchema,
    payload: decisionPayloadSchema,
  })
  .strict();

export const undoHumanCardInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    expected_version: humanPositiveVersionSchema,
  })
  .strict();

export const deferHumanCardInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    expected_version: humanPositiveVersionSchema,
    action: z.enum(["defer", "restore"]),
  })
  .strict();

export const retryHumanTaskInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    expected_version: humanPositiveVersionSchema,
  })
  .strict();

export const listHumanHistoryQuerySchema = z
  .object({
    filter: z.enum(["all", "accepted", "declined", "failed"]).default("all"),
    cursor: z.string().trim().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const updateHumanWorkspaceInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    expected_version: humanPositiveVersionSchema,
    goal: z.string().max(2000).optional(),
    allowed_scope: z.string().max(2000).optional(),
    budget_limit: budgetLimitSchema.optional(),
    is_paused: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.goal !== undefined ||
      data.allowed_scope !== undefined ||
      data.budget_limit !== undefined ||
      data.is_paused !== undefined,
    { message: "At least one workspace field must be provided for update." },
  );

export const createWorkerBotInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    display_name: z.string().trim().min(1).max(120),
    scopes: z
      .array(z.enum(BOT_SCOPES))
      .min(1)
      .max(BOT_SCOPES.length)
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "Bot scopes must not contain duplicates.",
      }),
  })
  .strict();

export const updateHumanBotInputSchema = z
  .object({
    request_id: humanRequestIdSchema,
    expected_version: humanPositiveVersionSchema,
    display_name: z.string().trim().min(1).max(120).optional(),
    scopes: z
      .array(z.enum(BOT_SCOPES))
      .min(1)
      .max(BOT_SCOPES.length)
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "Bot scopes must not contain duplicates.",
      })
      .optional(),
    status: z.enum(["active", "paused", "revoked"]).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.display_name !== undefined || data.scopes !== undefined || data.status !== undefined,
    { message: "At least one bot field must be provided for update." },
  );

export type ListHumanCardsQuery = z.infer<typeof listHumanCardsQuerySchema>;
export type DecideHumanCardInput = z.infer<typeof decideHumanCardInputSchema>;
export type UndoHumanCardInput = z.infer<typeof undoHumanCardInputSchema>;
export type DeferHumanCardInput = z.infer<typeof deferHumanCardInputSchema>;
export type RetryHumanTaskInput = z.infer<typeof retryHumanTaskInputSchema>;
export type ListHumanHistoryQuery = z.infer<typeof listHumanHistoryQuerySchema>;
export type UpdateHumanWorkspaceInput = z.infer<typeof updateHumanWorkspaceInputSchema>;
export type CreateWorkerBotInput = z.infer<typeof createWorkerBotInputSchema>;
export type UpdateHumanBotInput = z.infer<typeof updateHumanBotInputSchema>;
