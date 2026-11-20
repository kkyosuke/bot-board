import { describe, expect, test } from "bun:test";

import {
  assertCanClaimTask,
  assertCanDeferCard,
  assertCanRetryTask,
  assertCanSubmitProposal,
  assertCanSupersedeProposal,
  assertCanUndoCard,
  assertCardIsFinalizedForBot,
  assertDecisionCardNotFinalized,
  assertExpectedVersion,
  assertGroupDeclinePolicyConsistency,
  DEFAULT_BUDGET_LIMIT,
  DomainError,
  type ErrorCode,
  evaluateBudgetLimit,
  evaluateCardDecidePreconditions,
  evaluateCardFinalizeOutcome,
  parseBudgetLimit,
  resolveTaskStatusAfterDecisionFinalized,
  resolveTaskStatusOnRecordResult,
  resolveTaskStatusWhenCardsInactive,
  serializeBudgetLimit,
} from "@/domain";

function expectDomainError(
  fn: () => unknown,
  expected: {
    readonly code: ErrorCode;
    readonly retryable?: boolean;
    readonly replacementCardId?: string;
  },
): void {
  try {
    fn();
    throw new Error(`Expected DomainError(${expected.code}), but no error was thrown.`);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    if (err instanceof DomainError) {
      expect(err.code).toBe(expected.code);
      if (expected.retryable !== undefined) {
        expect(err.retryable).toBe(expected.retryable);
      }
      if (expected.replacementCardId !== undefined) {
        expect(err.details?.replacementCardId).toBe(expected.replacementCardId);
      }
    }
  }
}

describe("domain task state transitions (DEC-03, DEC-04, BOT-03)", () => {
  test("requires_approval=true forbids direct record_result(success) -> done", () => {
    expectDomainError(
      () =>
        resolveTaskStatusOnRecordResult({
          taskStatus: "running",
          outcome: "success",
          requiresApproval: true,
        }),
      { code: "INVALID_TRANSITION", retryable: false },
    );

    expect(
      resolveTaskStatusOnRecordResult({
        taskStatus: "running",
        outcome: "success",
        requiresApproval: false,
      }),
    ).toBe("done");
  });

  test("failed and declined never map to done (BOT-03)", () => {
    expect(
      resolveTaskStatusOnRecordResult({
        taskStatus: "running",
        outcome: "failed",
        requiresApproval: false,
      }),
    ).toBe("failed");

    expect(
      resolveTaskStatusAfterDecisionFinalized({
        cardType: "deliverable",
        decisionResult: "declined",
        onDeclinePolicy: "revise",
        remainingUndecidedInGroup: 0,
      }),
    ).toBe("ready");

    expect(
      resolveTaskStatusAfterDecisionFinalized({
        cardType: "deliverable",
        decisionResult: "declined",
        onDeclinePolicy: "block",
        remainingUndecidedInGroup: 0,
      }),
    ).toBe("blocked");
  });

  test("group decline keeps waiting_human while siblings remain undecided and rejects NaN/float counts (DEC-04, M3)", () => {
    expect(
      resolveTaskStatusAfterDecisionFinalized({
        cardType: "choice",
        decisionResult: "declined",
        onDeclinePolicy: "revise",
        remainingUndecidedInGroup: 2,
      }),
    ).toBe("waiting_human");

    expect(
      resolveTaskStatusAfterDecisionFinalized({
        cardType: "deliverable",
        decisionResult: "accepted",
        onDeclinePolicy: "revise",
        remainingUndecidedInGroup: 0,
      }),
    ).toBe("done");

    expect(
      resolveTaskStatusAfterDecisionFinalized({
        cardType: "policy",
        decisionResult: "accepted",
        onDeclinePolicy: "revise",
        remainingUndecidedInGroup: 0,
      }),
    ).toBe("ready");

    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expectDomainError(
        () =>
          resolveTaskStatusAfterDecisionFinalized({
            cardType: "choice",
            decisionResult: "declined",
            onDeclinePolicy: "revise",
            remainingUndecidedInGroup: bad,
          }),
        { code: "VALIDATION_ERROR", retryable: false },
      );
      expectDomainError(() => resolveTaskStatusWhenCardsInactive(bad), {
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    }
  });

  test("claim, submit, supersede, retry, and inactive-card guards enforce exact transitions and codes (M3)", () => {
    expect(() => assertCanClaimTask("ready", false)).not.toThrow();
    expectDomainError(() => assertCanClaimTask("ready", true), {
      code: "WORKSPACE_PAUSED",
      retryable: true,
    });
    expectDomainError(() => assertCanClaimTask("running", false), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });

    expect(() => assertCanSubmitProposal("running")).not.toThrow();
    expectDomainError(() => assertCanSubmitProposal("waiting_human"), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });

    // Superseding a pending sibling while another sibling was declined is ALLOWED (DEC-04)
    expect(() =>
      assertCanSupersedeProposal({
        taskStatus: "waiting_human",
        targetCardStatus: "pending",
        groupCardStatuses: ["declined", "pending"],
      }),
    ).not.toThrow();

    // Provisional in group is retryable: true
    expectDomainError(
      () =>
        assertCanSupersedeProposal({
          taskStatus: "waiting_human",
          targetCardStatus: "pending",
          groupCardStatuses: ["pending", "provisional"],
        }),
      { code: "INVALID_TRANSITION", retryable: true },
    );

    // Terminal targets (closed, expired, superseded, accepted, declined) cannot be superseded
    for (const terminal of ["closed", "expired", "superseded", "accepted", "declined"] as const) {
      expectDomainError(
        () =>
          assertCanSupersedeProposal({
            taskStatus: "waiting_human",
            targetCardStatus: terminal,
            groupCardStatuses: [terminal],
          }),
        { code: "INVALID_TRANSITION", retryable: false },
      );
    }

    // Accepted sibling blocks superseding another sibling
    expectDomainError(
      () =>
        assertCanSupersedeProposal({
          taskStatus: "waiting_human",
          targetCardStatus: "pending",
          groupCardStatuses: ["pending", "accepted"],
        }),
      { code: "INVALID_TRANSITION", retryable: false },
    );

    expect(assertCanRetryTask("failed")).toBe("ready");
    expect(assertCanRetryTask("blocked")).toBe("ready");
    expectDomainError(() => assertCanRetryTask("done"), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });

    expect(resolveTaskStatusWhenCardsInactive(0)).toBe("ready");
    expect(resolveTaskStatusWhenCardsInactive(1)).toBe("waiting_human");
  });
});

describe("domain decision card transitions & version/expiry checks (DEC-01..DEC-04, M2)", () => {
  test("forbids exposing provisional decisions to Bot/Worker (DEC-01) and forbids mutating finalized cards", () => {
    expectDomainError(() => assertCardIsFinalizedForBot("provisional", "provisional"), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });
    expectDomainError(() => assertCardIsFinalizedForBot("accepted", "provisional"), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });
    expect(() => assertCardIsFinalizedForBot("accepted", "finalized")).not.toThrow();
    expect(() => assertCardIsFinalizedForBot("declined", "finalized")).not.toThrow();

    expectDomainError(() => assertDecisionCardNotFinalized("accepted"), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });
    expectDomainError(() => assertDecisionCardNotFinalized("declined"), {
      code: "INVALID_TRANSITION",
      retryable: false,
    });
    expect(() => assertDecisionCardNotFinalized("provisional")).not.toThrow();
  });

  test("returns STALE_PROPOSAL + replacementCardId even when superseded incremented version, and classifies terminal cards as INVALID_TRANSITION instead of GROUP_LOCKED (M2)", () => {
    const base = {
      cardStatus: "pending" as const,
      expectedVersion: 1,
      currentVersion: 1,
      nowMs: 1_000_000,
      expiresAtMs: 2_000_000,
      targetTaskVersion: 3,
      currentTaskVersion: 3,
      targetArtifactVersion: 2,
      currentArtifactVersion: 2,
      hasGroupLock: false,
    };

    expect(evaluateCardDecidePreconditions(base)).toEqual({ outcome: "ok" });
    expect(evaluateCardDecidePreconditions({ ...base, expiresAtMs: 1_000_000 })).toEqual({
      outcome: "expired",
    });
    expect(evaluateCardDecidePreconditions({ ...base, currentTaskVersion: 4 })).toEqual({
      outcome: "stale",
    });
    expect(evaluateCardDecidePreconditions({ ...base, currentArtifactVersion: 3 })).toEqual({
      outcome: "stale",
    });

    // DEC-03 (1): supersede_proposal bumped version 1 -> 2, Human sends expectedVersion=1 -> MUST return STALE_PROPOSAL
    expectDomainError(
      () =>
        evaluateCardDecidePreconditions({
          ...base,
          cardStatus: "superseded",
          expectedVersion: 1,
          currentVersion: 2,
          replacementCardId: "card-next-42",
        }),
      {
        code: "STALE_PROPOSAL",
        retryable: false,
        replacementCardId: "card-next-42",
      },
    );

    // Pending card under group lock -> GROUP_LOCKED (retryable: true)
    expectDomainError(() => evaluateCardDecidePreconditions({ ...base, hasGroupLock: true }), {
      code: "GROUP_LOCKED",
      retryable: true,
    });

    // Already closed card under group lock -> INVALID_TRANSITION (retryable: false), NOT GROUP_LOCKED
    expectDomainError(
      () =>
        evaluateCardDecidePreconditions({
          ...base,
          cardStatus: "closed",
          hasGroupLock: true,
        }),
      {
        code: "INVALID_TRANSITION",
        retryable: false,
      },
    );
  });

  test("enforces 5-second undo exclusivity and finalize outcome classification", () => {
    expect(() =>
      assertCanUndoCard({
        cardStatus: "provisional",
        expectedVersion: 2,
        currentVersion: 2,
        nowMs: 1_004_999,
        provisionalUntilMs: 1_005_000,
      }),
    ).not.toThrow();

    expectDomainError(
      () =>
        assertCanUndoCard({
          cardStatus: "provisional",
          expectedVersion: 2,
          currentVersion: 2,
          nowMs: 1_005_000,
          provisionalUntilMs: 1_005_000,
        }),
      { code: "INVALID_TRANSITION", retryable: false },
    );

    expect(
      evaluateCardFinalizeOutcome({
        cardStatus: "provisional",
        provisionalResult: "accepted",
        nowMs: 1_004_999,
        provisionalUntilMs: 1_005_000,
        expiresAtMs: 2_000_000,
        targetTaskVersion: 1,
        currentTaskVersion: 1,
      }),
    ).toBe("noop");

    expect(
      evaluateCardFinalizeOutcome({
        cardStatus: "provisional",
        provisionalResult: "accepted",
        nowMs: 1_005_000,
        provisionalUntilMs: 1_005_000,
        expiresAtMs: 2_000_000,
        targetTaskVersion: 1,
        currentTaskVersion: 2,
      }),
    ).toBe("stale");

    expect(
      evaluateCardFinalizeOutcome({
        cardStatus: "provisional",
        provisionalResult: "accepted",
        nowMs: 1_005_000,
        provisionalUntilMs: 1_005_000,
        expiresAtMs: 2_000_000,
        targetTaskVersion: 1,
        currentTaskVersion: 1,
      }),
    ).toBe("accepted");
  });

  test("enforces group decline policy consistency, defer transitions (status before group lock), and expected_version", () => {
    expect(() => assertGroupDeclinePolicyConsistency(["revise", "revise"])).not.toThrow();
    expectDomainError(() => assertGroupDeclinePolicyConsistency(["revise", "block"]), {
      code: "VALIDATION_ERROR",
      retryable: false,
    });

    expect(() =>
      assertCanDeferCard({
        cardStatus: "pending",
        targetStatus: "deferred",
        expectedVersion: 1,
        currentVersion: 1,
        hasGroupLock: false,
      }),
    ).not.toThrow();

    expectDomainError(
      () =>
        assertCanDeferCard({
          cardStatus: "pending",
          targetStatus: "deferred",
          expectedVersion: 1,
          currentVersion: 1,
          hasGroupLock: true,
        }),
      { code: "GROUP_LOCKED", retryable: true },
    );

    expectDomainError(
      () =>
        assertCanDeferCard({
          cardStatus: "closed",
          targetStatus: "deferred",
          expectedVersion: 1,
          currentVersion: 1,
          hasGroupLock: true,
        }),
      { code: "INVALID_TRANSITION", retryable: false },
    );

    expectDomainError(() => assertExpectedVersion(1, 2, "Task"), {
      code: "VERSION_CONFLICT",
      retryable: false,
    });
  });
});

describe("structured budget_limit Zod schema & enforcement", () => {
  test("parses valid structured JSON and rejects malformed or free-text values", () => {
    const serialized = serializeBudgetLimit(DEFAULT_BUDGET_LIMIT);
    expect(parseBudgetLimit(serialized)).toEqual(DEFAULT_BUDGET_LIMIT);

    expectDomainError(() => parseBudgetLimit("1日20件くらい"), {
      code: "VALIDATION_ERROR",
      retryable: false,
    });
    expectDomainError(
      () =>
        parseBudgetLimit({
          max_cards_per_day: 0,
          max_steps_per_task: 5,
          daily_cost_limit_cents: 100,
        }),
      { code: "VALIDATION_ERROR", retryable: false },
    );
    expectDomainError(
      () =>
        parseBudgetLimit({
          max_cards_per_day: 10,
          max_steps_per_task: 5,
          daily_cost_limit_cents: 100,
          unknown_extra: true,
        }),
      { code: "VALIDATION_ERROR", retryable: false },
    );
  });

  test("evaluates card, step, and daily cost limits and rejects NaN or negative usage", () => {
    expect(
      evaluateBudgetLimit(DEFAULT_BUDGET_LIMIT, {
        cardsCreatedToday: 10,
        stepsExecutedForTask: 3,
        costCentsToday: 120,
      }),
    ).toEqual({ allowed: true });

    const cardBreach = evaluateBudgetLimit(DEFAULT_BUDGET_LIMIT, {
      cardsCreatedToday: 40,
      stepsExecutedForTask: 1,
      costCentsToday: 0,
    });
    expect(cardBreach.allowed).toBe(false);
    if (!cardBreach.allowed) {
      expect(cardBreach.breachedLimit).toBe("max_cards_per_day");
    }

    const costBreach = evaluateBudgetLimit(DEFAULT_BUDGET_LIMIT, {
      cardsCreatedToday: 1,
      stepsExecutedForTask: 1,
      costCentsToday: 500,
    });
    expect(costBreach.allowed).toBe(false);
    if (!costBreach.allowed) {
      expect(costBreach.breachedLimit).toBe("daily_cost_limit_cents");
    }

    expectDomainError(
      () =>
        evaluateBudgetLimit(DEFAULT_BUDGET_LIMIT, {
          cardsCreatedToday: Number.NaN,
          stepsExecutedForTask: 0,
          costCentsToday: 0,
        }),
      { code: "VALIDATION_ERROR", retryable: false },
    );
  });
});
