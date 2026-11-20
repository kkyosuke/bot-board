import { describe, expect, test } from "bun:test";

import {
  buildAcceptPayload,
  buildDeclinePayload,
  computeSwipeVisuals,
  type DecisionCardItem,
  DomainError,
  EDGE_GUARD_PX,
  isProtectedScreenEdge,
  resolveDragAxis,
  resolveSwipeOutcome,
  validateDecisionPayload,
} from "@/domain";

const SAMPLE_SINGLE_CARD: DecisionCardItem = {
  id: "card-s1",
  proposalId: "p-1",
  taskId: "t-1",
  taskTitle: "Auth",
  selectionGroupId: "grp-1",
  cardType: "choice",
  selectionMode: "single",
  typeLabel: "単一3択",
  shortChip: "3択",
  botName: "ChatGPT",
  submittedAtLabel: "1分前",
  version: 1,
  headline: "認証方式はどれにする？",
  summary: "比較",
  acceptEffect: "採用",
  declineEffect: "全案見送り",
  factors: [],
  options: [
    { id: "opt-a", title: "A", summary: "A", meta: "m", recommended: true },
    { id: "opt-b", title: "B", summary: "B", meta: "m" },
  ],
  artifact: {
    id: "a-1",
    title: "memo",
    kind: "doc",
    version: 1,
    summary: "sum",
    excerpt: ["line 1"],
  },
};

const SAMPLE_MULTI_CARD: DecisionCardItem = {
  ...SAMPLE_SINGLE_CARD,
  id: "card-m1",
  selectionMode: "multi",
  typeLabel: "複数チェック",
  options: [
    { id: "f-1", title: "F1", summary: "s", meta: "m", recommended: true },
    { id: "f-2", title: "F2", summary: "s", meta: "m", recommended: true },
    { id: "f-3", title: "F3", summary: "s", meta: "m" },
  ],
};

describe("domain decision payload validation (DEC-04)", () => {
  test("single-choice card accepts valid option and rejects unknown option", () => {
    const valid = buildAcceptPayload(SAMPLE_SINGLE_CARD, "opt-b", []);
    expect(valid).toEqual({ mode: "single", decision: "accepted", selectedOptionId: "opt-b" });

    expect(() =>
      validateDecisionPayload(SAMPLE_SINGLE_CARD, {
        mode: "single",
        decision: "accepted",
        selectedOptionId: "non-existent",
      }),
    ).toThrow(DomainError);

    expect(buildDeclinePayload(SAMPLE_SINGLE_CARD)).toEqual({
      mode: "single",
      decision: "declined",
    });
  });

  test("multi-select card classifies accepted/declined sets and rejects empty accept", () => {
    const valid = buildAcceptPayload(SAMPLE_MULTI_CARD, undefined, ["f-1", "f-3"]);
    expect(valid).toEqual({
      mode: "multi",
      decision: "accepted",
      acceptedOptionIds: ["f-1", "f-3"],
      declinedOptionIds: ["f-2"],
    });

    expect(() => buildAcceptPayload(SAMPLE_MULTI_CARD, undefined, [])).toThrow(DomainError);

    expect(buildDeclinePayload(SAMPLE_MULTI_CARD)).toEqual({
      mode: "multi",
      decision: "declined",
      acceptedOptionIds: [],
      declinedOptionIds: ["f-1", "f-2", "f-3"],
    });
  });

  test("multi-select validation rejects overlapping or omitted option classifications", () => {
    expect(() =>
      validateDecisionPayload(SAMPLE_MULTI_CARD, {
        mode: "multi",
        decision: "accepted",
        acceptedOptionIds: ["f-1"],
        declinedOptionIds: ["f-1", "f-2"],
      }),
    ).toThrow(DomainError);

    expect(() =>
      validateDecisionPayload(SAMPLE_MULTI_CARD, {
        mode: "multi",
        decision: "accepted",
        acceptedOptionIds: ["f-1"],
        declinedOptionIds: ["f-2"],
      }),
    ).toThrow(DomainError);

    expect(() => buildAcceptPayload(SAMPLE_MULTI_CARD, undefined, ["f-1", "unknown-id"])).toThrow(
      DomainError,
    );
    expect(() => buildAcceptPayload(SAMPLE_MULTI_CARD, undefined, ["f-1", "f-1"])).toThrow(
      DomainError,
    );

    expect(() =>
      validateDecisionPayload(SAMPLE_MULTI_CARD, {
        mode: "multi",
        decision: "declined",
        // @ts-expect-error -- verify runtime guard rejects non-empty acceptedOptionIds on declined multi payload
        acceptedOptionIds: ["f-1"],
        declinedOptionIds: ["f-2", "f-3"],
      }),
    ).toThrow(DomainError);
  });
});

describe("domain swipe gesture rules (UX-04)", () => {
  test("protects SP left/right 24px screen edges without blocking PC drags", () => {
    expect(isProtectedScreenEdge(10, 0, 360, true)).toBe(true);
    expect(isProtectedScreenEdge(360 - EDGE_GUARD_PX + 1, 0, 360, true)).toBe(true);
    expect(isProtectedScreenEdge(180, 0, 360, true)).toBe(false);
    expect(isProtectedScreenEdge(10, 0, 1280, false)).toBe(false);
  });

  test("separates vertical scrolling from horizontal swipe gestures", () => {
    expect(resolveDragAxis(4, 3)).toBe("pending");
    expect(resolveDragAxis(20, 40)).toBe("vertical");
    expect(resolveDragAxis(45, 18)).toBe("horizontal");
    expect(resolveDragAxis(-45, 10)).toBe("horizontal");
  });

  test("cancels sub-threshold drags and commits threshold distance or fast flicks", () => {
    expect(resolveSwipeOutcome(55, 300)).toBe("cancel");
    expect(resolveSwipeOutcome(-55, 300)).toBe("cancel");
    expect(resolveSwipeOutcome(110, 400)).toBe("accepted");
    expect(resolveSwipeOutcome(-110, 400)).toBe("declined");
    expect(resolveSwipeOutcome(56, 80)).toBe("accepted");
    expect(resolveSwipeOutcome(-56, 80)).toBe("declined");
  });

  test("computes bounded rotation and directional progress", () => {
    const right = computeSwipeVisuals(120, 30);
    expect(right.direction).toBe("right");
    expect(right.progress).toBe(1);
    expect(right.rotationDeg).toBeLessThanOrEqual(11);

    const left = computeSwipeVisuals(-50, 0);
    expect(left.direction).toBe("left");
    expect(left.progress).toBeGreaterThan(0);
    expect(left.progress).toBeLessThan(1);
  });
});
