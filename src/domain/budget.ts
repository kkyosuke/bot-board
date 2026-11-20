import { z } from "zod";

import { DomainError } from "./errors";

export const budgetLimitSchema = z
  .object({
    max_cards_per_day: z.number().int().min(1).max(1000),
    max_steps_per_task: z.number().int().min(1).max(200),
    daily_cost_limit_cents: z.number().int().min(0).max(1_000_000),
  })
  .strict();

export type BudgetLimit = z.infer<typeof budgetLimitSchema>;

export const DEFAULT_BUDGET_LIMIT: Readonly<BudgetLimit> = Object.freeze({
  max_cards_per_day: 40,
  max_steps_per_task: 12,
  daily_cost_limit_cents: 500,
});

export interface BudgetUsageSnapshot {
  readonly cardsCreatedToday: number;
  readonly stepsExecutedForTask: number;
  readonly costCentsToday: number;
}

export type BudgetCheckResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly breachedLimit: keyof BudgetLimit;
      readonly message: string;
    };

export function parseBudgetLimit(raw: unknown): BudgetLimit {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new DomainError(
        "VALIDATION_ERROR",
        "budget_limit must be valid JSON matching the structured budget schema.",
        false,
      );
    }
  }

  const parsed = budgetLimitSchema.safeParse(candidate);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "budget_limit"}: ${issue.message}`)
      .join("; ");
    throw new DomainError("VALIDATION_ERROR", `Invalid budget_limit (${issueSummary}).`, false);
  }
  return parsed.data;
}

export function serializeBudgetLimit(limit: BudgetLimit): string {
  const validated = parseBudgetLimit(limit);
  return JSON.stringify(validated);
}

function assertNonNegativeFinite(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Budget usage field "${fieldName}" must be a finite non-negative number.`,
      false,
    );
  }
}

export function evaluateBudgetLimit(
  limit: BudgetLimit,
  usage: BudgetUsageSnapshot,
): BudgetCheckResult {
  assertNonNegativeFinite(usage.cardsCreatedToday, "cardsCreatedToday");
  assertNonNegativeFinite(usage.stepsExecutedForTask, "stepsExecutedForTask");
  assertNonNegativeFinite(usage.costCentsToday, "costCentsToday");

  if (usage.cardsCreatedToday >= limit.max_cards_per_day) {
    return {
      allowed: false,
      breachedLimit: "max_cards_per_day",
      message: `Daily card limit reached (${usage.cardsCreatedToday}/${limit.max_cards_per_day}).`,
    };
  }
  if (usage.stepsExecutedForTask >= limit.max_steps_per_task) {
    return {
      allowed: false,
      breachedLimit: "max_steps_per_task",
      message: `Per-task step limit reached (${usage.stepsExecutedForTask}/${limit.max_steps_per_task}).`,
    };
  }
  if (usage.costCentsToday >= limit.daily_cost_limit_cents) {
    return {
      allowed: false,
      breachedLimit: "daily_cost_limit_cents",
      message: `Daily cost limit reached (${usage.costCentsToday}/${limit.daily_cost_limit_cents} cents).`,
    };
  }
  return { allowed: true };
}
