import {
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type BoardViewState,
  buildAcceptPayload,
  buildDeclinePayload,
  computeSwipeVisuals,
  type DecisionCardItem,
  DomainError,
  type DragAxisLock,
  getDefaultCheckedOptionIds,
  getDefaultSelectedOptionId,
  isBoardViewState,
  isProtectedScreenEdge,
  resolveDragAxis,
  resolveSwipeOutcome,
  type SwipeVisualState,
} from "@/domain";

import {
  type CardDetailSnapshot,
  ClientAuthError,
  ClientTransportError,
  type DecisionCardClient,
  type DecisionQueueSnapshot,
} from "./api/decision-client";
import { createHttpDecisionClient } from "./api/http-decision-client";
import { createMockDecisionClient } from "./api/mock-decision-client";
import { ActionBar } from "./components/ActionBar";
import { BoardStateCard } from "./components/BoardStateCard";
import { BottomNav, type NavTabId } from "./components/BottomNav";
import { DecisionCard } from "./components/DecisionCard";
import {
  type ActivityLogEntry,
  ActivityLogList,
  CardDetailContent,
} from "./components/DetailPanel";
import { SheetModal } from "./components/SheetModal";
import { type ProvisionalToastEntry, UndoBanner } from "./components/UndoBanner";
import { BoardPage } from "./pages/BoardPage";
import { ConsentPage } from "./pages/ConsentPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignInPage } from "./pages/SignInPage";
import { buildSignInRedirectPath, useSpaRouter } from "./router";

export interface AppProps {
  readonly client?: DecisionCardClient;
  readonly initialViewState?: BoardViewState;
}

interface DecisionBoardPageProps extends AppProps {
  readonly search: string;
  readonly onNavigate: (to: string, options?: { readonly replace?: boolean }) => void;
}

interface ActiveDragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  readonly lastDx: number;
  readonly axisLock: DragAxisLock;
}

interface StoredProvisionalState extends ProvisionalToastEntry {
  readonly selectedOptionId: string | undefined;
  readonly checkedOptionIds: readonly string[] | undefined;
}

type OpenSheetMode = "detail" | "deferred" | null;
type InspectorTab = "detail" | "log";

function formatClockNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

function readUseMockMode(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("mode") === "mock";
}

function readInitialStateFromUrl(search: string): BoardViewState {
  const param = new URLSearchParams(search).get("state");
  return isBoardViewState(param) ? param : "normal";
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatClientError(err: unknown, fallback: string): string {
  if (err instanceof DomainError || err instanceof ClientTransportError) {
    return err.message;
  }
  return fallback;
}

function isRetryableClientError(err: unknown): boolean {
  return (err instanceof DomainError && err.retryable) || err instanceof ClientTransportError;
}

function formatDecisionLabel(
  card: DecisionCardItem,
  decision: "accepted" | "declined",
  selectedOptionId: string | undefined,
  checkedCount: number,
): string {
  if (decision === "declined") {
    return card.selectionMode === "binary" ? "見送りを仮確定" : "全案見送りを仮確定";
  }
  if (card.selectionMode === "binary") {
    return "採用を仮確定";
  }
  if (card.selectionMode === "single") {
    const opt = card.options?.find((item) => item.id === selectedOptionId);
    return opt !== undefined ? `「${opt.title}」を採用仮確定` : "選択を仮確定";
  }
  return `${checkedCount}件を採用仮確定`;
}

function DecisionBoardPage(props: DecisionBoardPageProps): ReactElement {
  const { search, onNavigate } = props;
  const isMockMode = props.client === undefined && readUseMockMode(search);
  const clientRef = useRef<DecisionCardClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current =
      props.client ?? (isMockMode ? createMockDecisionClient() : createHttpDecisionClient());
  }
  const client = clientRef.current;

  const [viewState, setViewState] = useState<BoardViewState>(
    () => props.initialViewState ?? readInitialStateFromUrl(search),
  );
  const [pendingCards, setPendingCards] = useState<readonly DecisionCardItem[]>([]);
  const [deferredCards, setDeferredCards] = useState<readonly DecisionCardItem[]>([]);
  const [workspacePaused, setWorkspacePaused] = useState<boolean>(false);
  const [hasActiveBots, setHasActiveBots] = useState<boolean | null>(null);
  const [runningTaskCount, setRunningTaskCount] = useState<number>(0);
  const [topCardDetail, setTopCardDetail] = useState<CardDetailSnapshot | null>(null);
  const [hasLoaded, setHasLoaded] = useState<boolean>(false);
  const [totalInitialCount, setTotalInitialCount] = useState<number>(6);
  const [clearedCount, setClearedCount] = useState<number>(0);
  const [badgePopKey, setBadgePopKey] = useState<number>(0);

  const [selectedByCardId, setSelectedByCardId] = useState<Readonly<Record<string, string>>>({});
  const [checkedByCardId, setCheckedByCardId] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});

  const [provisionalQueue, setProvisionalQueue] = useState<readonly StoredProvisionalState[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [activityLogs, setActivityLogs] = useState<readonly ActivityLogEntry[]>([]);
  const [hintText, setHintText] = useState<string>("右へスワイプで採用・左で見送り");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);

  const [swipeVisual, setSwipeVisual] = useState<SwipeVisualState | null>(null);
  const [flyDirection, setFlyDirection] = useState<"right" | "left" | "down" | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isBusy, setIsBusy] = useState<boolean>(false);

  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("detail");
  const [openSheet, setOpenSheet] = useState<OpenSheetMode>(null);

  const dragRef = useRef<ActiveDragState | null>(null);
  const busyRef = useRef<boolean>(false);
  const provisionalQueueRef = useRef<readonly StoredProvisionalState[]>([]);
  const initializedTotalRef = useRef<boolean>(false);
  const logSeqRef = useRef<number>(1);
  const reqSeqRef = useRef<number>(1);
  const deckFrameRef = useRef<HTMLDivElement | null>(null);
  const inspectorTabBaseId = useId();

  const acquireBusy = useCallback((): boolean => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = true;
    setIsBusy(true);
    return true;
  }, []);

  const releaseBusy = useCallback((): void => {
    busyRef.current = false;
    setIsBusy(false);
  }, []);

  const nextRequestId = useCallback((prefix: string): string => {
    const id = `${prefix}-${Date.now()}-${reqSeqRef.current}`;
    reqSeqRef.current += 1;
    return id;
  }, []);

  const appendLog = useCallback(
    (kind: ActivityLogEntry["kind"], title: string, detail: string, payloadJson?: string): void => {
      const entry: ActivityLogEntry = {
        id: `log-${logSeqRef.current}`,
        time: formatClockNow(),
        kind,
        title,
        detail,
        ...(payloadJson !== undefined ? { payloadJson } : {}),
      };
      logSeqRef.current += 1;
      setActivityLogs((prev) => [entry, ...prev].slice(0, 30));
    },
    [],
  );

  const hydrateSelectionDefaults = useCallback((cards: readonly DecisionCardItem[]): void => {
    setSelectedByCardId((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const card of cards) {
        if (next[card.id] === undefined) {
          const defId = getDefaultSelectedOptionId(card);
          if (defId !== undefined) {
            next[card.id] = defId;
          }
        }
      }
      return next;
    });

    setCheckedByCardId((prev) => {
      const next: Record<string, readonly string[]> = { ...prev };
      for (const card of cards) {
        if (next[card.id] === undefined && card.selectionMode === "multi") {
          next[card.id] = getDefaultCheckedOptionIds(card);
        }
      }
      return next;
    });
  }, []);

  const handleAuthRedirect = useCallback(
    (err: unknown): boolean => {
      if (!(err instanceof ClientAuthError)) {
        return false;
      }
      onNavigate(
        err.status === 401
          ? buildSignInRedirectPath(`/${search}`)
          : "/sign-in?error=NOT_AUTHORIZED",
        { replace: true },
      );
      return true;
    },
    [onNavigate, search],
  );

  const applyQueueSnapshot = useCallback(
    (
      snapshot: DecisionQueueSnapshot,
      options?: { readonly restoreProvisional?: boolean; readonly focusCardId?: string },
    ): void => {
      let orderedPending = [...snapshot.pendingCards];
      if (options?.focusCardId !== undefined) {
        const focusIdx = orderedPending.findIndex((c) => c.id === options.focusCardId);
        if (focusIdx > 0) {
          const [focused] = orderedPending.splice(focusIdx, 1);
          if (focused !== undefined) {
            orderedPending = [focused, ...orderedPending];
          }
        }
      }
      setPendingCards(orderedPending);
      setDeferredCards(snapshot.deferredCards);
      if (snapshot.workspacePaused !== undefined) {
        setWorkspacePaused(snapshot.workspacePaused);
      }
      if (snapshot.hasActiveBots !== undefined) {
        setHasActiveBots(snapshot.hasActiveBots);
      }
      if (snapshot.runningTaskCount !== undefined) {
        setRunningTaskCount(snapshot.runningTaskCount);
      }
      if (options?.restoreProvisional === true && snapshot.provisionalCards !== undefined) {
        const now = Date.now();
        const restored: StoredProvisionalState[] = [...snapshot.provisionalCards]
          .filter((item) => item.provisionalUntil > now)
          .sort((a, b) => a.provisionalUntil - b.provisionalUntil)
          .map((item) => ({
            cardId: item.card.id,
            headline: item.card.headline,
            label: formatDecisionLabel(
              item.card,
              item.decision,
              item.card.selectionMode === "single" ? item.selectedOptionIds[0] : undefined,
              item.selectedOptionIds.length,
            ),
            isDecline: item.decision === "declined",
            expectedVersion: item.card.version,
            provisionalUntil: item.provisionalUntil,
            selectedOptionId:
              item.card.selectionMode === "single" ? item.selectedOptionIds[0] : undefined,
            checkedOptionIds:
              item.card.selectionMode === "multi" ? item.selectedOptionIds : undefined,
          }));
        provisionalQueueRef.current = restored;
        setProvisionalQueue(restored);
        setNowMs(now);
      }
      setLoadErrorMessage(null);
      hydrateSelectionDefaults(orderedPending);
    },
    [hydrateSelectionDefaults],
  );

  // Sync offline simulation mode with viewState without wiping queue progress
  useEffect(() => {
    client.setOfflineMode?.(viewState === "offline_error");
  }, [client, viewState]);

  // Load initial queue snapshot with error recovery & reload provisional restoration
  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      try {
        const snapshot = await client.listCards();
        if (!active) {
          return;
        }
        applyQueueSnapshot(snapshot, { restoreProvisional: true });
        if (!initializedTotalRef.current) {
          initializedTotalRef.current = true;
          setTotalInitialCount(
            Math.max(1, snapshot.pendingCards.length + snapshot.deferredCards.length),
          );
        }
      } catch (err) {
        if (!active) {
          return;
        }
        if (handleAuthRedirect(err)) {
          return;
        }
        const message = formatClientError(err, "カードの読み込みに失敗しました。");
        setLoadErrorMessage(message);
        setHintText(message);
        appendLog("error", "初期読み込み失敗", message);
      } finally {
        if (active) {
          setHasLoaded(true);
        }
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [client, applyQueueSnapshot, handleAuthRedirect, appendLog]);

  // Tick 5-second undo countdown & finalize expired provisional entries outside state updaters (StrictMode-safe)
  useEffect(() => {
    if (provisionalQueue.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      const currentQueue = provisionalQueueRef.current;
      const expired = currentQueue.filter((item) => item.provisionalUntil <= current);
      if (expired.length === 0) {
        return;
      }
      const remaining = currentQueue.filter((item) => item.provisionalUntil > current);
      provisionalQueueRef.current = remaining;
      setProvisionalQueue(remaining);
      for (const item of expired) {
        appendLog("finalized", `確定完了→Bot送信: ${item.headline}`, item.label);
      }
      // In live HTTP mode, refresh listCards() after expiry to trigger on-demand finalization fallback
      if (!isMockMode && client.getCardDetail !== undefined) {
        void client
          .listCards()
          .then((snap) => {
            applyQueueSnapshot(snap);
          })
          .catch(() => {
            // Non-fatal background sync error
          });
      }
    }, 100);

    return () => {
      window.clearInterval(timer);
    };
  }, [provisionalQueue.length, appendLog, isMockMode, client, applyQueueSnapshot]);

  const isInteractiveMode = viewState === "normal" || viewState === "offline_error";
  const topCard = isInteractiveMode ? (pendingCards[0] ?? null) : null;

  // Fetch full artifact content & siblings for top card in live HTTP mode
  useEffect(() => {
    if (topCard === null || client.getCardDetail === undefined) {
      setTopCardDetail(null);
      return;
    }
    let active = true;
    const cardId = topCard.id;
    void client
      .getCardDetail(cardId)
      .then((detail) => {
        if (active) {
          setTopCardDetail(detail);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          handleAuthRedirect(err);
        }
      });
    return () => {
      active = false;
    };
  }, [client, topCard, handleAuthRedirect]);

  const topSelectedOptionId =
    topCard !== null
      ? (selectedByCardId[topCard.id] ?? getDefaultSelectedOptionId(topCard))
      : undefined;
  const topCheckedOptionIds = useMemo<readonly string[]>(() => {
    if (topCard === null) {
      return [];
    }
    return checkedByCardId[topCard.id] ?? getDefaultCheckedOptionIds(topCard);
  }, [topCard, checkedByCardId]);

  const handleSelectOption = useCallback((cardId: string, optionId: string): void => {
    setSelectedByCardId((prev) => ({ ...prev, [cardId]: optionId }));
  }, []);

  const handleToggleOption = useCallback((card: DecisionCardItem, optionId: string): void => {
    setCheckedByCardId((prev) => {
      const current = prev[card.id] ?? getDefaultCheckedOptionIds(card);
      const exists = current.includes(optionId);
      const updated = exists ? current.filter((id) => id !== optionId) : [...current, optionId];
      return { ...prev, [card.id]: updated };
    });
  }, []);

  const handleToggleAllOptions = useCallback((card: DecisionCardItem): void => {
    const allIds = (card.options ?? []).map((opt) => opt.id);
    setCheckedByCardId((prev) => {
      const current = prev[card.id] ?? getDefaultCheckedOptionIds(card);
      const next = current.length === allIds.length ? [] : allIds;
      return { ...prev, [card.id]: next };
    });
  }, []);

  const refreshAfterConflictIfNeeded = useCallback(
    async (err: unknown): Promise<void> => {
      if (
        !(err instanceof DomainError) ||
        (err.code !== "VERSION_CONFLICT" &&
          err.code !== "GROUP_LOCKED" &&
          err.code !== "INVALID_TRANSITION" &&
          err.code !== "NOT_FOUND")
      ) {
        return;
      }
      try {
        const refreshed = await client.listCards();
        applyQueueSnapshot(refreshed, { restoreProvisional: true });
      } catch (refreshErr) {
        handleAuthRedirect(refreshErr);
      }
    },
    [client, applyQueueSnapshot, handleAuthRedirect],
  );

  const commitTopCardDecision = useCallback(
    async (decision: "accepted" | "declined"): Promise<void> => {
      if (topCard === null) {
        return;
      }

      if (
        decision === "accepted" &&
        topCard.selectionMode === "multi" &&
        topCheckedOptionIds.length === 0
      ) {
        setSwipeVisual(null);
        setHintText("1件以上チェックしてから確定してください（左スワイプで全部見送り）");
        return;
      }

      if (
        decision === "accepted" &&
        topCard.selectionMode === "single" &&
        (topSelectedOptionId === undefined ||
          !(topCard.options ?? []).some((opt) => opt.id === topSelectedOptionId))
      ) {
        setSwipeVisual(null);
        setHintText("候補を1つ選択してから確定してください（左スワイプで全案見送り）");
        return;
      }

      if (!acquireBusy()) {
        return;
      }

      try {
        const payload =
          decision === "accepted"
            ? buildAcceptPayload(topCard, topSelectedOptionId, topCheckedOptionIds)
            : buildDeclinePayload(topCard);

        const receipt = await client.decideCard({
          cardId: topCard.id,
          expectedVersion: topCard.version,
          requestId: nextRequestId("decide"),
          payload,
        });

        const label = formatDecisionLabel(
          topCard,
          decision,
          topSelectedOptionId,
          topCheckedOptionIds.length,
        );

        setFlyDirection(decision === "accepted" ? "right" : "left");

        const animationMs = prefersReducedMotion() ? 10 : 230;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, animationMs);
        });

        let refreshErrorMessage: string | null = null;
        try {
          const snapshot = await client.listCards();
          applyQueueSnapshot(snapshot);
        } catch (refreshErr) {
          if (handleAuthRedirect(refreshErr)) {
            return;
          }
          const closedIds = new Set([topCard.id, ...receipt.closedSiblingCardIds]);
          setPendingCards((prev) => prev.filter((item) => !closedIds.has(item.id)));
          setDeferredCards((prev) => prev.filter((item) => !closedIds.has(item.id)));
          refreshErrorMessage = formatClientError(refreshErr, "一覧の再取得に失敗しました。");
        }

        const nextEntry: StoredProvisionalState = {
          cardId: receipt.cardId,
          headline: topCard.headline,
          label,
          isDecline: decision === "declined",
          expectedVersion: receipt.newVersion,
          provisionalUntil: receipt.provisionalUntil,
          selectedOptionId: topSelectedOptionId,
          checkedOptionIds:
            topCard.selectionMode === "multi" ? [...topCheckedOptionIds] : undefined,
        };
        const updatedQueue = [
          ...provisionalQueueRef.current.filter((item) => item.cardId !== nextEntry.cardId),
          nextEntry,
        ];
        provisionalQueueRef.current = updatedQueue;
        setNowMs(Date.now());
        setProvisionalQueue(updatedQueue);

        setClearedCount((count) => count + 1 + receipt.closedSiblingCardIds.length);
        setBadgePopKey((k) => k + 1);
        setHintText(
          refreshErrorMessage !== null
            ? `${label}（5秒間取り消し可・${refreshErrorMessage}）`
            : `${label}（5秒間取り消し可）`,
        );
        appendLog(
          decision,
          `${label}: ${topCard.headline}`,
          decision === "accepted" ? topCard.acceptEffect : topCard.declineEffect,
          JSON.stringify(payload),
        );
      } catch (err) {
        if (handleAuthRedirect(err)) {
          return;
        }
        if (err instanceof DomainError && err.code === "STALE_PROPOSAL") {
          const replacementIdRaw = err.details?.replacementCardId;
          const replacementCardId =
            replacementIdRaw !== undefined && replacementIdRaw.trim() !== ""
              ? replacementIdRaw
              : undefined;
          try {
            const refreshed = await client.listCards();
            applyQueueSnapshot(refreshed, {
              restoreProvisional: true,
              ...(replacementCardId !== undefined ? { focusCardId: replacementCardId } : {}),
            });
          } catch (refreshErr) {
            if (handleAuthRedirect(refreshErr)) {
              return;
            }
          }
          const staleMsg =
            replacementCardId !== undefined
              ? "対象タスクまたは成果が更新されたため、再確認カードへ切り替えました。"
              : err.message;
          setHintText(staleMsg);
          appendLog("error", `再確認カード切替 (STALE_PROPOSAL): ${topCard.headline}`, staleMsg);
          return;
        }
        await refreshAfterConflictIfNeeded(err);
        const message = formatClientError(
          err,
          "保存に失敗しました。カードは判断待ちへ戻しています。",
        );
        setHintText(message);
        appendLog("error", `送信失敗（未確定）: ${topCard.headline}`, message);
      } finally {
        setFlyDirection(null);
        setSwipeVisual(null);
        setIsDragging(false);
        releaseBusy();
      }
    },
    [
      topCard,
      topCheckedOptionIds,
      topSelectedOptionId,
      acquireBusy,
      releaseBusy,
      client,
      nextRequestId,
      applyQueueSnapshot,
      handleAuthRedirect,
      refreshAfterConflictIfNeeded,
      appendLog,
    ],
  );

  const deferTopCard = useCallback(async (): Promise<void> => {
    if (topCard === null || !acquireBusy()) {
      return;
    }

    try {
      await client.deferCard({
        cardId: topCard.id,
        expectedVersion: topCard.version,
        requestId: nextRequestId("defer"),
        action: "defer",
      });

      setFlyDirection("down");
      const animationMs = prefersReducedMotion() ? 10 : 200;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, animationMs);
      });

      const snapshot = await client.listCards();
      applyQueueSnapshot(snapshot);
      setHintText("「あとで」へ回しました（未決定のまま保留）");
      appendLog("defer", `保留（あとで）: ${topCard.headline}`, "右上の「あとで」から復帰できます");
    } catch (err) {
      if (handleAuthRedirect(err)) {
        return;
      }
      await refreshAfterConflictIfNeeded(err);
      const message = formatClientError(err, "保留に失敗しました。");
      setHintText(message);
      appendLog("error", `保留失敗: ${topCard.headline}`, message);
    } finally {
      setFlyDirection(null);
      setSwipeVisual(null);
      releaseBusy();
    }
  }, [
    topCard,
    acquireBusy,
    releaseBusy,
    client,
    nextRequestId,
    applyQueueSnapshot,
    handleAuthRedirect,
    refreshAfterConflictIfNeeded,
    appendLog,
  ]);

  const restoreDeferredCard = useCallback(
    async (card: DecisionCardItem): Promise<void> => {
      if (!acquireBusy()) {
        return;
      }
      try {
        await client.deferCard({
          cardId: card.id,
          expectedVersion: card.version,
          requestId: nextRequestId("restore"),
          action: "restore",
        });
        const snapshot = await client.listCards();
        applyQueueSnapshot(snapshot, { focusCardId: card.id });
        setOpenSheet(null);
        setHintText("保留カードを判断キュー先頭へ戻しました");
      } catch (err) {
        if (handleAuthRedirect(err)) {
          return;
        }
        await refreshAfterConflictIfNeeded(err);
        const message = formatClientError(err, "保留カードの復帰に失敗しました。");
        setHintText(message);
        appendLog("error", `復帰失敗: ${card.headline}`, message);
      } finally {
        releaseBusy();
      }
    },
    [
      acquireBusy,
      releaseBusy,
      client,
      nextRequestId,
      applyQueueSnapshot,
      handleAuthRedirect,
      refreshAfterConflictIfNeeded,
      appendLog,
    ],
  );

  const undoLatestProvisional = useCallback(async (): Promise<void> => {
    const currentQueue = provisionalQueueRef.current;
    const latest = currentQueue[currentQueue.length - 1];
    if (latest === undefined || !acquireBusy()) {
      return;
    }

    try {
      const receipt = await client.undoCard({
        cardId: latest.cardId,
        expectedVersion: latest.expectedVersion,
        requestId: nextRequestId("undo"),
      });

      const snapshot = receipt.refreshedSnapshot ?? (await client.listCards());
      applyQueueSnapshot(snapshot, { focusCardId: receipt.cardId });

      if (latest.selectedOptionId !== undefined) {
        const preservedId = latest.selectedOptionId;
        setSelectedByCardId((prev) => ({ ...prev, [receipt.cardId]: preservedId }));
      }
      if (latest.checkedOptionIds !== undefined) {
        const preservedChecked = latest.checkedOptionIds;
        setCheckedByCardId((prev) => ({ ...prev, [receipt.cardId]: preservedChecked }));
      }

      const remaining = provisionalQueueRef.current.filter((item) => item.cardId !== latest.cardId);
      provisionalQueueRef.current = remaining;
      setProvisionalQueue(remaining);
      setClearedCount((count) => Math.max(0, count - (1 + receipt.restoredSiblingCards.length)));
      setHintText("取り消しました（仮確定キャンセル・Bot未着手）");
      appendLog(
        "undo",
        `5秒以内取消: ${latest.headline}`,
        "Botへ渡す前に選択状態のまま判断待ちへ復帰",
      );
    } catch (err) {
      if (handleAuthRedirect(err)) {
        return;
      }
      const keepForRetry = isRetryableClientError(err) && latest.provisionalUntil > Date.now();
      if (!keepForRetry) {
        const remaining = provisionalQueueRef.current.filter(
          (item) => item.cardId !== latest.cardId,
        );
        provisionalQueueRef.current = remaining;
        setProvisionalQueue(remaining);
      }
      const message = formatClientError(
        err,
        "取り消し猶予（5秒）を過ぎたため取り消せませんでした。",
      );
      setHintText(message);
      appendLog("error", `取消失敗: ${latest.headline}`, message);
    } finally {
      releaseBusy();
    }
  }, [
    acquireBusy,
    releaseBusy,
    client,
    nextRequestId,
    applyQueueSnapshot,
    handleAuthRedirect,
    appendLog,
  ]);

  const handleResetDemo = useCallback(async (): Promise<void> => {
    if (!acquireBusy()) {
      return;
    }
    try {
      const isMockReset = client.resetDemoQueue !== undefined;
      const snapshot =
        client.resetDemoQueue !== undefined
          ? await client.resetDemoQueue()
          : await client.listCards();
      initializedTotalRef.current = true;
      setViewState("normal");
      if (isMockReset) {
        provisionalQueueRef.current = [];
        setProvisionalQueue([]);
        setClearedCount(0);
        setActivityLogs([]);
        setSelectedByCardId({});
        setCheckedByCardId({});
      }
      applyQueueSnapshot(snapshot, { restoreProvisional: !isMockReset });
      setTotalInitialCount(
        Math.max(1, snapshot.pendingCards.length + snapshot.deferredCards.length),
      );
      setHintText(
        isMockReset ? "右へスワイプで採用・左で見送り" : "最新の判断キューを再取得しました",
      );
    } catch (err) {
      if (handleAuthRedirect(err)) {
        return;
      }
      const message = formatClientError(err, "キューの再読み込みに失敗しました。");
      setLoadErrorMessage(message);
      setHintText(message);
      appendLog("error", "再読み込み失敗", message);
    } finally {
      releaseBusy();
    }
  }, [acquireBusy, releaseBusy, client, applyQueueSnapshot, handleAuthRedirect, appendLog]);

  const handleRecoverOnline = useCallback((): void => {
    client.setOfflineMode?.(false);
    setViewState("normal");
    setHintText("オンライン復帰：最新版を確認して再操作できます");
  }, [client]);

  const handleJumpCardToFront = useCallback((index: number): void => {
    if (busyRef.current || dragRef.current !== null) {
      return;
    }
    setPendingCards((prev) => {
      if (index <= 0 || index >= prev.length) {
        return prev;
      }
      const target = prev[index];
      if (target === undefined) {
        return prev;
      }
      return [target, ...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  }, []);

  const resetActiveDrag = useCallback((): void => {
    if (dragRef.current === null) {
      return;
    }
    dragRef.current = null;
    setIsDragging(false);
    setSwipeVisual(null);
  }, []);

  // Ensure drags released outside the card before horizontal pointer capture never stay stuck
  useEffect(() => {
    if (!isDragging) {
      return;
    }
    const onWindowRelease = (event: globalThis.PointerEvent): void => {
      const drag = dragRef.current;
      if (drag !== null && drag.pointerId === event.pointerId) {
        resetActiveDrag();
      }
    };
    const onWindowBlur = (): void => {
      resetActiveDrag();
    };

    window.addEventListener("pointerup", onWindowRelease);
    window.addEventListener("pointercancel", onWindowRelease);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerup", onWindowRelease);
      window.removeEventListener("pointercancel", onWindowRelease);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [isDragging, resetActiveDrag]);

  // Pointer Swipe Handlers (UX-04: edge guard + vertical scroll separation + threshold)
  const handleCardPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      if (busyRef.current || topCard === null) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest('[data-no-drag="true"], button, a, input, select, textarea') !== null
      ) {
        return;
      }

      const frameEl = deckFrameRef.current;
      if (frameEl !== null) {
        const rect = frameEl.getBoundingClientRect();
        const isCompactTouch = window.innerWidth < 768;
        if (isProtectedScreenEdge(event.clientX, rect.left, rect.width, isCompactTouch)) {
          setHintText("画面端24pxはOS戻るジェスチャーを優先しました");
          return;
        }
      }

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: performance.now(),
        lastDx: 0,
        axisLock: "pending",
      };
      setIsDragging(true);
    },
    [topCard],
  );

  const handleCardPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }

      if (event.pointerType === "mouse" && event.buttons === 0) {
        resetActiveDrag();
        return;
      }

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      let axisLock = drag.axisLock;

      if (axisLock === "pending") {
        axisLock = resolveDragAxis(dx, dy);
        if (axisLock === "pending") {
          return;
        }
        if (axisLock === "vertical") {
          dragRef.current = null;
          setIsDragging(false);
          setSwipeVisual(null);
          setHintText("縦スクロール優先中（横スワイプ誤判定を防止）");
          return;
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic pointer events in tests may not have an active browser pointer ID.
        }
      }

      if (axisLock !== "horizontal") {
        return;
      }

      event.preventDefault();
      dragRef.current = {
        ...drag,
        axisLock: "horizontal",
        lastDx: dx,
      };
      setSwipeVisual(computeSwipeVisuals(dx, dy));
    },
    [resetActiveDrag],
  );

  const finishCardPointer = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      dragRef.current = null;
      setIsDragging(false);

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore if capture was not acquired.
      }

      if (drag.axisLock !== "horizontal") {
        setSwipeVisual(null);
        return;
      }

      const elapsedMs = performance.now() - drag.startTime;
      const outcome = resolveSwipeOutcome(drag.lastDx, elapsedMs);
      if (outcome === "cancel") {
        setSwipeVisual(null);
        if (Math.abs(drag.lastDx) > 20) {
          setHintText("閾値未満のため未送信で戻しました");
        }
        return;
      }

      void commitTopCardDecision(outcome);
    },
    [commitTopCardDecision],
  );

  const handleCardPointerCancel = useCallback((): void => {
    resetActiveDrag();
  }, [resetActiveDrag]);

  // Keyboard Alternatives (UX-05)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
          event.target.isContentEditable)
      ) {
        return;
      }
      if (openSheet !== null || event.altKey) {
        return;
      }

      const key = event.key;
      const lower = key.toLowerCase();
      const hasPrimaryModifier = event.ctrlKey || event.metaKey;

      if (hasPrimaryModifier) {
        if (!event.shiftKey && lower === "z" && provisionalQueueRef.current.length > 0) {
          event.preventDefault();
          void undoLatestProvisional();
        }
        return;
      }

      if (
        (key === "ArrowLeft" || key === "ArrowRight") &&
        event.target instanceof Element &&
        event.target.closest('[role="tablist"]') !== null
      ) {
        return;
      }

      if (key === "ArrowRight" || lower === "d") {
        event.preventDefault();
        void commitTopCardDecision("accepted");
      } else if (key === "ArrowLeft" || lower === "a") {
        event.preventDefault();
        void commitTopCardDecision("declined");
      } else if (key === "ArrowDown" || lower === "s") {
        event.preventDefault();
        void deferTopCard();
      } else if (lower === "z" || key === "Backspace") {
        if (provisionalQueueRef.current.length > 0) {
          event.preventDefault();
          void undoLatestProvisional();
        }
      } else if (topCard !== null && ["1", "2", "3", "4"].includes(key)) {
        const optionIdx = Number(key) - 1;
        const targetOption = topCard.options?.[optionIdx];
        if (targetOption === undefined) {
          return;
        }
        if (topCard.selectionMode === "single") {
          handleSelectOption(topCard.id, targetOption.id);
        } else if (topCard.selectionMode === "multi") {
          handleToggleOption(topCard, targetOption.id);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    openSheet,
    commitTopCardDecision,
    deferTopCard,
    undoLatestProvisional,
    topCard,
    handleSelectOption,
    handleToggleOption,
  ]);

  const handleSelectNav = useCallback(
    (tab: NavTabId): void => {
      if (tab === "decide") {
        onNavigate("/");
        return;
      }
      if (tab === "board") {
        onNavigate("/board");
        return;
      }
      if (tab === "history") {
        onNavigate("/history");
        return;
      }
      onNavigate("/settings");
    },
    [onNavigate],
  );

  const handleCloseSheet = useCallback((): void => {
    setOpenSheet(null);
  }, []);

  const remainingCount = isInteractiveMode ? pendingCards.length : 0;
  const effectiveTotalCount = Math.max(
    totalInitialCount,
    clearedCount + pendingCards.length + deferredCards.length,
  );
  const progressPct = Math.min(100, Math.round((clearedCount / effectiveTotalCount) * 100));
  const latestProvisional = provisionalQueue[provisionalQueue.length - 1] ?? null;

  const nonInteractiveState: Exclude<BoardViewState, "normal" | "offline_error"> | null =
    viewState === "loading" ||
    viewState === "empty" ||
    viewState === "bot_running" ||
    viewState === "bot_disconnected"
      ? viewState
      : !hasLoaded
        ? "loading"
        : pendingCards.length === 0
          ? hasActiveBots === false
            ? "bot_disconnected"
            : runningTaskCount > 0
              ? "bot_running"
              : "empty"
          : null;

  return (
    <div
      ref={deckFrameRef}
      className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 py-3 sm:px-6 sm:py-5"
    >
      {/* Top Progress Header */}
      <header
        className="mb-3 flex items-center justify-between gap-2 border-b pb-3"
        style={{ borderColor: "var(--border-default)" }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-bold tracking-tight sm:text-lg">判断キュー</h1>
            <span
              key={badgePopKey}
              data-testid="remaining-badge"
              className="bb-pop inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums"
              style={{
                backgroundColor: "var(--tone-info-bg)",
                borderColor: "var(--tone-info-border)",
              }}
            >
              残り {remainingCount}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="判断キュー消費進捗"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct}
              className="h-1.5 w-28 overflow-hidden rounded-full border sm:w-44"
              style={{
                backgroundColor: "var(--surface-subtle)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <div
                className="bb-progress-fill h-full rounded-full"
                style={{
                  width: `${progressPct}%`,
                  backgroundColor: "var(--tone-accept)",
                }}
              />
            </div>
            <span
              data-testid="cleared-counter"
              className="text-xs tabular-nums"
              style={{ color: "var(--ink-muted)" }}
            >
              消費 {clearedCount}/{effectiveTotalCount}件
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!isMockMode ? (
            <button
              type="button"
              data-testid="btn-live-refresh"
              disabled={isBusy}
              onClick={() => {
                void handleResetDemo();
              }}
              aria-label="判断キューを最新化"
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl border px-2.5 text-xs font-semibold disabled:opacity-45"
              style={{
                backgroundColor: "var(--surface-card)",
                borderColor: "var(--border-default)",
              }}
            >
              更新
            </button>
          ) : null}
          <button
            type="button"
            data-testid="btn-open-deferred"
            onClick={() => setOpenSheet("deferred")}
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold"
            style={{
              backgroundColor: "var(--surface-card)",
              borderColor: "var(--border-default)",
            }}
          >
            <span>あとで</span>
            <span
              data-testid="deferred-count"
              className="rounded-md px-1.5 py-0.5 tabular-nums"
              style={{
                backgroundColor: "var(--surface-subtle)",
                color: "var(--ink-muted)",
              }}
            >
              {deferredCards.length}
            </span>
          </button>
        </div>
      </header>

      {workspacePaused ? (
        <div
          role="alert"
          data-testid="decide-paused-banner"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-xs"
          style={{
            borderColor: "var(--tone-decline-border)",
            backgroundColor: "var(--tone-decline-bg)",
          }}
        >
          <div className="min-w-0">
            <div className="font-bold" style={{ color: "var(--tone-decline)" }}>
              WORKSPACE_PAUSED: 緊急一時停止中
            </div>
            <div style={{ color: "var(--ink-muted)" }}>
              全 Bot の新規書込・Queue ワーカー起動を停止中です。再開は設定画面から行えます。
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("/settings")}
            className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-3 font-bold"
            style={{
              backgroundColor: "var(--accent-primary)",
              color: "var(--accent-primary-ink)",
            }}
          >
            設定で解除
          </button>
        </div>
      ) : null}

      {/* Queue Quick-Jump Strip */}
      {isInteractiveMode && pendingCards.length > 0 ? (
        <div
          className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-2 text-xs"
          aria-label="待機中カード一覧"
        >
          {pendingCards.map((card, idx) => (
            <button
              key={card.id}
              type="button"
              disabled={isBusy}
              data-testid={`queue-chip-${card.id}`}
              onClick={() => handleJumpCardToFront(idx)}
              className="min-h-[44px] min-w-[44px] shrink-0 cursor-pointer rounded-full border px-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundColor: idx === 0 ? "var(--tone-info-bg)" : "var(--surface-card)",
                borderColor: idx === 0 ? "var(--tone-info-border)" : "var(--border-subtle)",
                color: idx === 0 ? "var(--ink-primary)" : "var(--ink-muted)",
                fontWeight: idx === 0 ? 700 : 500,
              }}
            >
              {idx + 1}. {card.shortChip}
            </button>
          ))}
        </div>
      ) : null}

      {/* Main Content Grid */}
      <main className="grid flex-1 grid-cols-1 items-start gap-5 lg:grid-cols-12">
        {/* Primary Column: Card Stack + Action Bar + 5s Undo */}
        <section className="flex w-full flex-col items-center lg:col-span-7">
          <div
            className="mb-2 flex min-h-[22px] w-full max-w-[445px] items-center justify-between gap-2 px-1 text-xs"
            style={{ color: "var(--ink-muted)" }}
          >
            <span data-testid="gesture-hint" className="truncate">
              {hintText}
            </span>
            <span className="hidden shrink-0 tabular-nums sm:inline">← / → / ↓ / 1-4 / Z</span>
          </div>

          {viewState === "offline_error" ? (
            <div
              data-testid="offline-banner"
              role="alert"
              className="mb-2.5 flex w-full max-w-[445px] items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
              style={{
                backgroundColor: "var(--tone-warn-bg)",
                borderColor: "var(--tone-warn-border)",
              }}
            >
              <div className="leading-snug">
                <strong className="block">オフラインのため未送信</strong>
                <span style={{ color: "var(--ink-muted)" }}>
                  判断は確定されず判断待ちへ戻ります。復帰後に再操作してください。
                </span>
              </div>
              <button
                type="button"
                data-testid="btn-recover-online"
                onClick={handleRecoverOnline}
                className="min-h-[44px] min-w-[44px] shrink-0 cursor-pointer rounded-lg border px-3 font-semibold"
                style={{
                  backgroundColor: "var(--surface-card)",
                  borderColor: "var(--border-default)",
                }}
              >
                復帰
              </button>
            </div>
          ) : null}

          <div
            data-testid="card-deck"
            className="relative flex min-h-[465px] w-full max-w-[445px] items-stretch justify-center select-none"
          >
            {!isMockMode &&
            loadErrorMessage !== null &&
            pendingCards.length === 0 &&
            hasLoaded &&
            viewState === "normal" ? (
              <div
                role="alert"
                data-testid="live-load-error"
                className="bb-card-shadow flex w-full flex-col items-center justify-center gap-4 rounded-2xl border p-6 text-center"
                style={{
                  backgroundColor: "var(--surface-card)",
                  borderColor: "var(--tone-warn-border)",
                }}
              >
                <div className="space-y-1.5">
                  <h2 className="text-base font-bold" style={{ color: "var(--tone-warn)" }}>
                    判断カードの読み込みに失敗しました
                  </h2>
                  <p
                    className="mx-auto max-w-xs text-xs leading-relaxed sm:text-sm"
                    style={{ color: "var(--ink-muted)" }}
                  >
                    {loadErrorMessage}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="btn-live-load-retry"
                  disabled={isBusy}
                  onClick={() => {
                    void handleResetDemo();
                  }}
                  className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-xl px-4 text-xs font-bold disabled:opacity-45"
                  style={{
                    backgroundColor: "var(--accent-primary)",
                    color: "var(--accent-primary-ink)",
                  }}
                >
                  再読み込み
                </button>
              </div>
            ) : nonInteractiveState !== null ? (
              <BoardStateCard
                viewState={nonInteractiveState}
                clearedCount={clearedCount}
                deferredCount={deferredCards.length}
                isLiveMode={!isMockMode}
                runningTaskCount={runningTaskCount}
                onOpenDeferred={() => setOpenSheet("deferred")}
                onResetDemo={() => void handleResetDemo()}
                onOpenConnectHint={() => onNavigate("/settings")}
              />
            ) : (
              pendingCards
                .slice(0, 3)
                .map((card, idx) => ({ card, idx }))
                .reverse()
                .map(({ card, idx }) => (
                  <DecisionCard
                    key={card.id}
                    card={card}
                    layerIndex={idx}
                    swipeVisual={idx <= 1 ? swipeVisual : null}
                    flyDirection={idx === 0 ? flyDirection : null}
                    isDragging={isDragging}
                    selectedOptionId={selectedByCardId[card.id] ?? getDefaultSelectedOptionId(card)}
                    checkedOptionIds={checkedByCardId[card.id] ?? getDefaultCheckedOptionIds(card)}
                    onSelectOption={(optionId) => handleSelectOption(card.id, optionId)}
                    onToggleOption={(optionId) => handleToggleOption(card, optionId)}
                    onToggleAllOptions={() => handleToggleAllOptions(card)}
                    onOpenDetail={() => setOpenSheet("detail")}
                    onPointerDown={handleCardPointerDown}
                    onPointerMove={handleCardPointerMove}
                    onPointerUp={finishCardPointer}
                    onPointerCancel={handleCardPointerCancel}
                  />
                ))
            )}
          </div>

          <ActionBar
            card={topCard}
            disabled={isBusy || nonInteractiveState !== null}
            selectedOptionId={topSelectedOptionId}
            checkedCount={topCheckedOptionIds.length}
            onDecline={() => void commitTopCardDecision("declined")}
            onDefer={() => void deferTopCard()}
            onAccept={() => void commitTopCardDecision("accepted")}
          />

          <UndoBanner
            latestEntry={latestProvisional}
            extraCount={Math.max(0, provisionalQueue.length - 1)}
            nowMs={nowMs}
            isBusy={isBusy}
            onUndo={() => void undoLatestProvisional()}
          />
        </section>

        {/* PC Right-Hand Detail & Log Inspector */}
        <aside
          data-testid="pc-inspector"
          aria-label="カード詳細とイベントログ"
          className="hidden flex-col overflow-hidden rounded-2xl border lg:col-span-5 lg:flex"
          style={{
            backgroundColor: "var(--surface-card)",
            borderColor: "var(--border-default)",
          }}
        >
          <div
            className="flex items-center gap-1 border-b px-2 pt-1.5 text-xs"
            style={{ borderColor: "var(--border-default)" }}
            role="tablist"
            aria-label="インスペクター切替"
          >
            <button
              id={`${inspectorTabBaseId}-tab-detail`}
              type="button"
              role="tab"
              data-testid="tab-detail"
              aria-selected={inspectorTab === "detail"}
              aria-controls={`${inspectorTabBaseId}-panel`}
              onClick={() => setInspectorTab("detail")}
              className="min-h-[44px] min-w-[44px] cursor-pointer border-b-2 px-3 font-semibold"
              style={{
                borderBottomColor:
                  inspectorTab === "detail" ? "var(--accent-primary)" : "transparent",
                color: inspectorTab === "detail" ? "var(--ink-primary)" : "var(--ink-muted)",
              }}
            >
              詳細・成果比較
            </button>
            <button
              id={`${inspectorTabBaseId}-tab-log`}
              type="button"
              role="tab"
              data-testid="tab-log"
              aria-selected={inspectorTab === "log"}
              aria-controls={`${inspectorTabBaseId}-panel`}
              onClick={() => setInspectorTab("log")}
              className="min-h-[44px] min-w-[44px] cursor-pointer border-b-2 px-3 font-semibold"
              style={{
                borderBottomColor: inspectorTab === "log" ? "var(--accent-primary)" : "transparent",
                color: inspectorTab === "log" ? "var(--ink-primary)" : "var(--ink-muted)",
              }}
            >
              消費ログ ({activityLogs.length})
            </button>
          </div>
          <div
            id={`${inspectorTabBaseId}-panel`}
            role="tabpanel"
            aria-labelledby={
              inspectorTab === "detail"
                ? `${inspectorTabBaseId}-tab-detail`
                : `${inspectorTabBaseId}-tab-log`
            }
            className="max-h-[560px] space-y-4 overflow-y-auto p-4 text-sm"
          >
            {inspectorTab === "detail" ? (
              <CardDetailContent card={topCard} detail={topCardDetail} />
            ) : (
              <ActivityLogList logs={activityLogs} />
            )}
          </div>
        </aside>
      </main>

      <BottomNav activeTab="decide" onSelectTab={handleSelectNav} />

      {/* Bottom Sheet / Modal for Detail and Deferred List */}
      <SheetModal
        open={openSheet === "detail"}
        title="カード詳細・成果プレビュー"
        testId="detail-sheet"
        onClose={handleCloseSheet}
      >
        <CardDetailContent card={topCard} detail={topCardDetail} />
      </SheetModal>

      <SheetModal
        open={openSheet === "deferred"}
        title={`あとで保留中（${deferredCards.length}件）`}
        testId="deferred-sheet"
        onClose={handleCloseSheet}
      >
        {deferredCards.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
            保留中のカードはありません。迷ったカードは「あとで」ボタンでここに退避できます。
          </p>
        ) : (
          <div className="space-y-2">
            {deferredCards.map((card) => (
              <div
                key={card.id}
                className="flex items-center justify-between gap-3 rounded-xl border p-3"
                style={{ borderColor: "var(--border-default)" }}
              >
                <div className="min-w-0 text-xs">
                  <div style={{ color: "var(--ink-muted)" }}>
                    {card.typeLabel} ・ {card.taskTitle}
                  </div>
                  <div className="mt-0.5 font-semibold">{card.headline}</div>
                </div>
                <button
                  type="button"
                  data-testid={`btn-restore-${card.id}`}
                  onClick={() => void restoreDeferredCard(card)}
                  className="min-h-[44px] min-w-[44px] shrink-0 cursor-pointer rounded-xl px-3 text-xs font-semibold"
                  style={{
                    backgroundColor: "var(--accent-primary)",
                    color: "var(--accent-primary-ink)",
                  }}
                >
                  先頭へ戻す
                </button>
              </div>
            ))}
          </div>
        )}
      </SheetModal>
    </div>
  );
}

export function App(props: AppProps): ReactElement {
  const { location, navigate } = useSpaRouter();

  if (location.route === "/sign-in") {
    return <SignInPage search={location.search} onNavigate={navigate} />;
  }
  if (location.route === "/consent") {
    return <ConsentPage search={location.search} onNavigate={navigate} />;
  }
  if (location.route === "/board") {
    return <BoardPage onNavigate={navigate} />;
  }
  if (location.route === "/history") {
    return <HistoryPage onNavigate={navigate} />;
  }
  if (location.route === "/settings") {
    return <SettingsPage onNavigate={navigate} />;
  }
  return <DecisionBoardPage {...props} search={location.search} onNavigate={navigate} />;
}
