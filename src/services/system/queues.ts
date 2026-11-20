export interface DecisionFinalizeQueuePayload {
  readonly card_id: string;
}

export interface BotWorkQueuePayload {
  readonly decision_id?: string;
  readonly task_id: string;
  readonly workspace_id: string;
}

export interface QueueSendOptions {
  readonly delaySeconds?: number;
}

export interface DecisionFinalizeQueueProducer {
  send(message: DecisionFinalizeQueuePayload, options?: QueueSendOptions): Promise<unknown>;
}

export interface BotWorkQueueProducer {
  send(message: BotWorkQueuePayload, options?: QueueSendOptions): Promise<unknown>;
}
