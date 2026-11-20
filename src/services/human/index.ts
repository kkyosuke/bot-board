import { type OwnerContext } from "@/auth/context";
import {
  type AppDatabase,
  createD1Database,
  type D1LikeDatabase,
  didParentMutationApply,
  type GuardedMutationOutcome,
} from "@/db";
import { DomainError } from "@/domain";
import {
  decideHumanCard,
  deferHumanCard,
  getHumanCardDetail,
  type HumanCardDetailResult,
  type HumanCardServiceDeps,
  type HumanCardsListResult,
  type HumanDecideCardResult,
  type HumanDeferCardResult,
  type HumanUndoCardResult,
  listHumanCards,
  PROVISIONAL_WINDOW_MS,
  type ProvisionalCardView,
  undoHumanCard,
} from "@/services/human/card-services";
import {
  type CreateWorkerBotInput,
  type DecideHumanCardInput,
  type DeferHumanCardInput,
  type ListHumanCardsQuery,
  type ListHumanHistoryQuery,
  type RetryHumanTaskInput,
  type UndoHumanCardInput,
  type UpdateHumanBotInput,
  type UpdateHumanWorkspaceInput,
} from "@/services/human/schemas";
import {
  createWorkerBot,
  type CreateWorkerBotResult,
  getHumanBoard,
  getHumanWorkspace,
  type HumanBoardBotSummary,
  type HumanBoardResult,
  type HumanBoardTaskItem,
  type HumanBotConnectionView,
  type HumanHistoryItem,
  type HumanHistoryResult,
  type HumanWorkspaceServiceDeps,
  type HumanWorkspaceView,
  listHumanBots,
  listHumanHistory,
  retryHumanTask,
  type RetryHumanTaskResult,
  updateHumanBot,
  type UpdateHumanBotResult,
  updateHumanWorkspace,
  type UpdateHumanWorkspaceResult,
} from "@/services/human/workspace-services";

export {
  createWorkerBot,
  type CreateWorkerBotInput,
  type CreateWorkerBotResult,
  decideHumanCard,
  type DecideHumanCardInput,
  deferHumanCard,
  type DeferHumanCardInput,
  getHumanBoard,
  getHumanCardDetail,
  getHumanWorkspace,
  type HumanBoardBotSummary,
  type HumanBoardResult,
  type HumanBoardTaskItem,
  type HumanBotConnectionView,
  type HumanCardDetailResult,
  type HumanCardServiceDeps,
  type HumanCardsListResult,
  type HumanDecideCardResult,
  type HumanDeferCardResult,
  type HumanHistoryItem,
  type HumanHistoryResult,
  type HumanUndoCardResult,
  type HumanWorkspaceServiceDeps,
  type HumanWorkspaceView,
  listHumanBots,
  listHumanCards,
  type ListHumanCardsQuery,
  listHumanHistory,
  type ListHumanHistoryQuery,
  PROVISIONAL_WINDOW_MS,
  type ProvisionalCardView,
  retryHumanTask,
  type RetryHumanTaskInput,
  type RetryHumanTaskResult,
  undoHumanCard,
  type UndoHumanCardInput,
  updateHumanBot,
  type UpdateHumanBotInput,
  type UpdateHumanBotResult,
  updateHumanWorkspace,
  type UpdateHumanWorkspaceInput,
  type UpdateHumanWorkspaceResult,
};

export interface HumanServicePort {
  listCards(ctx: OwnerContext, query?: Partial<ListHumanCardsQuery>): Promise<HumanCardsListResult>;
  getCardDetail(ctx: OwnerContext, cardId: string): Promise<HumanCardDetailResult>;
  decideCard(
    ctx: OwnerContext,
    cardId: string,
    input: DecideHumanCardInput,
  ): Promise<HumanDecideCardResult>;
  undoCard(
    ctx: OwnerContext,
    cardId: string,
    input: UndoHumanCardInput,
  ): Promise<HumanUndoCardResult>;
  deferCard(
    ctx: OwnerContext,
    cardId: string,
    input: DeferHumanCardInput,
  ): Promise<HumanDeferCardResult>;
  getBoard(ctx: OwnerContext): Promise<HumanBoardResult>;
  retryTask(
    ctx: OwnerContext,
    taskId: string,
    input: RetryHumanTaskInput,
  ): Promise<RetryHumanTaskResult>;
  listHistory(
    ctx: OwnerContext,
    query?: Partial<ListHumanHistoryQuery>,
  ): Promise<HumanHistoryResult>;
  getWorkspace(ctx: OwnerContext): Promise<HumanWorkspaceView>;
  updateWorkspace(
    ctx: OwnerContext,
    input: UpdateHumanWorkspaceInput,
  ): Promise<UpdateHumanWorkspaceResult>;
  listBots(ctx: OwnerContext): Promise<readonly HumanBotConnectionView[]>;
  createWorkerBot(ctx: OwnerContext, input: CreateWorkerBotInput): Promise<CreateWorkerBotResult>;
  updateBot(
    ctx: OwnerContext,
    botId: string,
    input: UpdateHumanBotInput,
  ): Promise<UpdateHumanBotResult>;
}

export type CreateHumanServicePortOptions = HumanCardServiceDeps & HumanWorkspaceServiceDeps;

export function createHumanServicePort(
  db: AppDatabase,
  options: CreateHumanServicePortOptions = {},
): HumanServicePort {
  return {
    listCards(ctx, query) {
      return listHumanCards(db, ctx, query, options);
    },
    getCardDetail(ctx, cardId) {
      return getHumanCardDetail(db, ctx, cardId, options);
    },
    decideCard(ctx, cardId, input) {
      return decideHumanCard(db, ctx, cardId, input, options);
    },
    undoCard(ctx, cardId, input) {
      return undoHumanCard(db, ctx, cardId, input, options);
    },
    deferCard(ctx, cardId, input) {
      return deferHumanCard(db, ctx, cardId, input, options);
    },
    getBoard(ctx) {
      return getHumanBoard(db, ctx, options);
    },
    retryTask(ctx, taskId, input) {
      return retryHumanTask(db, ctx, taskId, input, options);
    },
    listHistory(ctx, query) {
      return listHumanHistory(db, ctx, query, options);
    },
    getWorkspace(ctx) {
      return getHumanWorkspace(db, ctx);
    },
    updateWorkspace(ctx, input) {
      return updateHumanWorkspace(db, ctx, input, options);
    },
    listBots(ctx) {
      return listHumanBots(db, ctx);
    },
    createWorkerBot(ctx, input) {
      return createWorkerBot(db, ctx, input, options);
    },
    updateBot(ctx, botId, input) {
      return updateHumanBot(db, ctx, botId, input, options);
    },
  };
}

export function createHumanServicePortFromD1(
  d1: D1LikeDatabase,
  options: CreateHumanServicePortOptions = {},
): HumanServicePort {
  let cachedPort: HumanServicePort | null = null;
  const getPort = (): HumanServicePort => {
    if (cachedPort === null) {
      cachedPort = createHumanServicePort(createD1Database(d1), options);
    }
    return cachedPort;
  };

  return {
    listCards(ctx, query) {
      return getPort().listCards(ctx, query);
    },
    getCardDetail(ctx, cardId) {
      return getPort().getCardDetail(ctx, cardId);
    },
    decideCard(ctx, cardId, input) {
      return getPort().decideCard(ctx, cardId, input);
    },
    undoCard(ctx, cardId, input) {
      return getPort().undoCard(ctx, cardId, input);
    },
    deferCard(ctx, cardId, input) {
      return getPort().deferCard(ctx, cardId, input);
    },
    getBoard(ctx) {
      return getPort().getBoard(ctx);
    },
    retryTask(ctx, taskId, input) {
      return getPort().retryTask(ctx, taskId, input);
    },
    listHistory(ctx, query) {
      return getPort().listHistory(ctx, query);
    },
    getWorkspace(ctx) {
      return getPort().getWorkspace(ctx);
    },
    updateWorkspace(ctx, input) {
      return getPort().updateWorkspace(ctx, input);
    },
    listBots(ctx) {
      return getPort().listBots(ctx);
    },
    createWorkerBot(ctx, input) {
      return getPort().createWorkerBot(ctx, input);
    },
    updateBot(ctx, botId, input) {
      return getPort().updateBot(ctx, botId, input);
    },
  };
}

export function assertOwnerWorkspaceAccess(ctx: OwnerContext, targetWorkspaceId: string): void {
  if (ctx.workspaceId !== targetWorkspaceId) {
    throw new DomainError("NOT_AUTHORIZED", "Workspace ownership mismatch.", false);
  }
}

export function verifyHumanMutationOutcome(parentChanges: number): GuardedMutationOutcome {
  return didParentMutationApply(parentChanges);
}
