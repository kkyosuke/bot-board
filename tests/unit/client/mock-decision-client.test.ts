import { describe, expect, test } from "bun:test";

import {
  ClientTransportError,
  createInitialDecisionCards,
  createMockDecisionClient,
} from "@/client";
import { DomainError, PROVISIONAL_UNDO_WINDOW_MS } from "@/domain";

describe("mock DecisionCardClient contract (DEC-01, DEC-02, offline safety)", () => {
  test("enforces 5-second provisional undo window and rejects undo after expiry", async () => {
    let now = 1_000_000;
    const client = createMockDecisionClient({ now: () => now });
    const initial = await client.listCards();
    const first = initial.pendingCards[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    const receipt = await client.decideCard({
      cardId: first.id,
      expectedVersion: first.version,
      requestId: "req-decide-1",
      payload: { mode: "binary", decision: "accepted" },
    });

    expect(receipt.status).toBe("provisional");
    expect(receipt.provisionalUntil).toBe(now + PROVISIONAL_UNDO_WINDOW_MS);

    // Undo within 5s restores card to top of queue
    now += 2_000;
    const undone = await client.undoCard({
      cardId: receipt.cardId,
      expectedVersion: receipt.newVersion,
      requestId: "req-undo-1",
    });
    expect(undone.status).toBe("pending");
    expect((await client.listCards()).pendingCards[0]?.id).toBe(first.id);

    // Decide again, advance past 5s window, and verify undo is rejected
    const secondReceipt = await client.decideCard({
      cardId: first.id,
      expectedVersion: undone.newVersion,
      requestId: "req-decide-2",
      payload: { mode: "binary", decision: "declined" },
    });
    now += PROVISIONAL_UNDO_WINDOW_MS;

    let caughtError: unknown;
    try {
      await client.undoCard({
        cardId: secondReceipt.cardId,
        expectedVersion: secondReceipt.newVersion,
        requestId: "req-undo-late",
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(DomainError);
    if (caughtError instanceof DomainError) {
      expect(caughtError.code).toBe("INVALID_TRANSITION");
    }
  });

  test("rejects decide, defer, restore, and undo while offline and preserves state", async () => {
    const client = createMockDecisionClient();
    const initial = await client.listCards();
    const first = initial.pendingCards[0];
    const second = initial.pendingCards[1];
    const third = initial.pendingCards[2];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (first === undefined || second === undefined || third === undefined) {
      return;
    }

    // Prepare one deferred card and one provisional card before going offline
    const deferredReceipt = await client.deferCard({
      cardId: second.id,
      expectedVersion: second.version,
      requestId: "req-pre-defer",
      action: "defer",
    });
    const provisionalReceipt = await client.decideCard({
      cardId: third.id,
      expectedVersion: third.version,
      requestId: "req-pre-decide",
      payload: {
        mode: "multi",
        decision: "declined",
        acceptedOptionIds: [],
        declinedOptionIds: (third.options ?? []).map((opt) => opt.id),
      },
    });

    const beforeOffline = await client.listCards();
    client.setOfflineMode?.(true);

    // 1. decideCard fails offline
    let decideErr: unknown;
    try {
      await client.decideCard({
        cardId: first.id,
        expectedVersion: first.version,
        requestId: "req-offline-decide",
        payload: { mode: "binary", decision: "accepted" },
      });
    } catch (err) {
      decideErr = err;
    }
    expect(decideErr).toBeInstanceOf(ClientTransportError);

    // 2. deferCard (defer) fails offline
    let deferErr: unknown;
    try {
      await client.deferCard({
        cardId: first.id,
        expectedVersion: first.version,
        requestId: "req-offline-defer",
        action: "defer",
      });
    } catch (err) {
      deferErr = err;
    }
    expect(deferErr).toBeInstanceOf(ClientTransportError);

    // 3. deferCard (restore) fails offline
    let restoreErr: unknown;
    try {
      await client.deferCard({
        cardId: deferredReceipt.cardId,
        expectedVersion: deferredReceipt.newVersion,
        requestId: "req-offline-restore",
        action: "restore",
      });
    } catch (err) {
      restoreErr = err;
    }
    expect(restoreErr).toBeInstanceOf(ClientTransportError);

    // 4. undoCard fails offline with retryable transport error
    let undoErr: unknown;
    try {
      await client.undoCard({
        cardId: provisionalReceipt.cardId,
        expectedVersion: provisionalReceipt.newVersion,
        requestId: "req-offline-undo",
      });
    } catch (err) {
      undoErr = err;
    }
    expect(undoErr).toBeInstanceOf(ClientTransportError);

    const afterOffline = await client.listCards();
    expect(afterOffline.pendingCards.map((c) => c.id)).toEqual(
      beforeOffline.pendingCards.map((c) => c.id),
    );
    expect(afterOffline.deferredCards.map((c) => c.id)).toEqual(
      beforeOffline.deferredCards.map((c) => c.id),
    );
  });

  test("enforces request_id idempotency and rejects mismatched payload reuse (DEC-02)", async () => {
    const client = createMockDecisionClient();
    const first = (await client.listCards()).pendingCards[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    const r1 = await client.decideCard({
      cardId: first.id,
      expectedVersion: first.version,
      requestId: "same-req",
      payload: { mode: "binary", decision: "accepted" },
    });
    const r2 = await client.decideCard({
      cardId: first.id,
      expectedVersion: first.version,
      requestId: "same-req",
      payload: { mode: "binary", decision: "accepted" },
    });
    expect(r2).toEqual(r1);

    let conflictErr: unknown;
    try {
      await client.decideCard({
        cardId: first.id,
        expectedVersion: first.version,
        requestId: "same-req",
        payload: { mode: "binary", decision: "declined" },
      });
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeInstanceOf(DomainError);
    if (conflictErr instanceof DomainError) {
      expect(conflictErr.code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  test("locks pending and deferred siblings in selection_group_id with GROUP_LOCKED, restores buckets on undo, and closes after 5s (DEC-04)", async () => {
    let now = 2_000_000;
    const baseCards = createInitialDecisionCards();
    const singleTemplate = baseCards.find((card) => card.selectionMode === "single");
    expect(singleTemplate).toBeDefined();
    if (singleTemplate === undefined) {
      return;
    }

    const pendingSibling = {
      ...singleTemplate,
      id: "card-single-sibling-pending",
      headline: "Pending Sibling Candidate",
    };
    const deferredSibling = {
      ...singleTemplate,
      id: "card-single-sibling-deferred",
      headline: "Deferred Sibling Candidate",
    };

    const client = createMockDecisionClient({
      now: () => now,
      initialCards: [singleTemplate, pendingSibling, deferredSibling],
    });

    // Defer one sibling before accepting the primary candidate
    const deferRes = await client.deferCard({
      cardId: deferredSibling.id,
      expectedVersion: deferredSibling.version,
      requestId: "req-defer-sibling",
      action: "defer",
    });

    const receipt = await client.decideCard({
      cardId: singleTemplate.id,
      expectedVersion: singleTemplate.version,
      requestId: "req-group-accept",
      payload: { mode: "single", decision: "accepted", selectedOptionId: "github-oauth" },
    });
    expect(receipt.closedSiblingCardIds).toEqual([
      "card-single-sibling-pending",
      "card-single-sibling-deferred",
    ]);

    const duringProvisional = await client.listCards();
    expect(duringProvisional.pendingCards.length).toBe(0);
    expect(duringProvisional.deferredCards.length).toBe(0);

    // Operating on either sibling while locked must throw GROUP_LOCKED
    let lockedDecideErr: unknown;
    try {
      await client.decideCard({
        cardId: pendingSibling.id,
        expectedVersion: pendingSibling.version,
        requestId: "req-locked-decide",
        payload: { mode: "single", decision: "accepted", selectedOptionId: "passkey" },
      });
    } catch (err) {
      lockedDecideErr = err;
    }
    expect(lockedDecideErr).toBeInstanceOf(DomainError);
    if (lockedDecideErr instanceof DomainError) {
      expect(lockedDecideErr.code).toBe("GROUP_LOCKED");
    }

    let lockedRestoreErr: unknown;
    try {
      await client.deferCard({
        cardId: deferredSibling.id,
        expectedVersion: deferRes.newVersion,
        requestId: "req-locked-restore",
        action: "restore",
      });
    } catch (err) {
      lockedRestoreErr = err;
    }
    expect(lockedRestoreErr).toBeInstanceOf(DomainError);
    if (lockedRestoreErr instanceof DomainError) {
      expect(lockedRestoreErr.code).toBe("GROUP_LOCKED");
    }

    // Undo restores pending sibling to pendingCards and deferred sibling back to deferredCards
    const undone = await client.undoCard({
      cardId: singleTemplate.id,
      expectedVersion: receipt.newVersion,
      requestId: "req-group-undo",
    });
    expect(undone.restoredSiblingCards.map((c) => c.id)).toEqual([
      "card-single-sibling-pending",
      "card-single-sibling-deferred",
    ]);
    const afterUndo = await client.listCards();
    expect(afterUndo.pendingCards.map((c) => c.id)).toEqual([singleTemplate.id, pendingSibling.id]);
    expect(afterUndo.deferredCards.map((c) => c.id)).toEqual([deferredSibling.id]);

    // Accept again and advance past 5s window -> group is permanently closed
    await client.decideCard({
      cardId: singleTemplate.id,
      expectedVersion: undone.newVersion,
      requestId: "req-group-accept-final",
      payload: { mode: "single", decision: "accepted", selectedOptionId: "github-oauth" },
    });
    now += PROVISIONAL_UNDO_WINDOW_MS;

    const afterFinalize = await client.listCards();
    expect(afterFinalize.pendingCards.length).toBe(0);
    expect(afterFinalize.deferredCards.length).toBe(0);

    let closedRestoreErr: unknown;
    try {
      await client.deferCard({
        cardId: deferredSibling.id,
        expectedVersion: deferRes.newVersion,
        requestId: "req-closed-restore",
        action: "restore",
      });
    } catch (err) {
      closedRestoreErr = err;
    }
    expect(closedRestoreErr).toBeInstanceOf(DomainError);
    if (closedRestoreErr instanceof DomainError) {
      expect(closedRestoreErr.code).toBe("GROUP_LOCKED");
    }
  });
});
