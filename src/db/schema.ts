import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ============================================================================
// Better Auth + @better-auth/mcp (OAuth 2.1 / OIDC / JWKS) Tables
// ============================================================================

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = sqliteTable("oauthClient", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull().unique(),
  clientSecret: text("clientSecret"),
  clientDiscoveryId: text("clientDiscoveryId"),
  disabled: integer("disabled", { mode: "boolean" }),
  skipConsent: integer("skipConsent", { mode: "boolean" }),
  enableEndSession: integer("enableEndSession", { mode: "boolean" }),
  subjectType: text("subjectType"),
  scopes: text("scopes"),
  clientCredentialsScopes: text("clientCredentialsScopes"),
  userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts"),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("softwareId"),
  softwareVersion: text("softwareVersion"),
  softwareStatement: text("softwareStatement"),
  redirectUris: text("redirectUris").notNull(),
  postLogoutRedirectUris: text("postLogoutRedirectUris"),
  backchannelLogoutUri: text("backchannelLogoutUri"),
  backchannelLogoutSessionRequired: integer("backchannelLogoutSessionRequired", {
    mode: "boolean",
  }),
  tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
  applicationType: text("applicationType"),
  jwks: text("jwks"),
  jwksUri: text("jwksUri"),
  grantTypes: text("grantTypes"),
  responseTypes: text("responseTypes"),
  requirePKCE: integer("requirePKCE", { mode: "boolean" }),
  dpopBoundAccessTokens: integer("dpopBoundAccessTokens", { mode: "boolean" }),
  referenceId: text("referenceId"),
  metadata: text("metadata"),
});

export const oauthResource = sqliteTable("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes"),
  customClaims: text("customClaims"),
  dpopBoundAccessTokensRequired: integer("dpopBoundAccessTokensRequired", { mode: "boolean" }),
  disabled: integer("disabled", { mode: "boolean" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
  policyVersion: integer("policyVersion"),
  metadata: text("metadata"),
});

export const oauthClientResource = sqliteTable(
  "oauthClientResource",
  {
    id: text("id").primaryKey(),
    clientId: text("clientId")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resourceId")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text("metadata"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("idx_oauth_client_resource_pair").on(table.clientId, table.resourceId)],
);

export const oauthRefreshToken = sqliteTable("oauthRefreshToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("referenceId"),
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources"),
  requestedUserInfoClaims: text("requestedUserInfoClaims"),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  revoked: integer("revoked", { mode: "timestamp_ms" }),
  rotatedAt: integer("rotatedAt", { mode: "timestamp_ms" }),
  rotationReplayResponse: text("rotationReplayResponse"),
  rotationReplayExpiresAt: integer("rotationReplayExpiresAt", { mode: "timestamp_ms" }),
  authTime: integer("authTime", { mode: "timestamp_ms" }),
  confirmation: text("confirmation"),
  scopes: text("scopes").notNull(),
});

export const oauthAccessToken = sqliteTable("oauthAccessToken", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("sessionId").references(() => session.id, { onDelete: "set null" }),
  userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("referenceId"),
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources"),
  requestedUserInfoClaims: text("requestedUserInfoClaims"),
  refreshId: text("refreshId").references(() => oauthRefreshToken.id, { onDelete: "set null" }),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  revoked: integer("revoked", { mode: "timestamp_ms" }),
  confirmation: text("confirmation"),
  scopes: text("scopes").notNull(),
});

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("referenceId"),
  resources: text("resources"),
  requestedUserInfoClaims: text("requestedUserInfoClaims"),
  scopes: text("scopes").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
});

export const oauthClientAssertion = sqliteTable("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
});

// ============================================================================
// Domain Tables (bot-board)
// ============================================================================

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  goal: text("goal").notNull().default(""),
  allowedScope: text("allowed_scope").notNull().default(""),
  budgetLimit: text("budget_limit").notNull(),
  isPaused: integer("is_paused", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const botConnections = sqliteTable(
  "bot_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    channelType: text("channel_type").notNull(),
    oauthClientId: text("oauth_client_id"),
    tokenHash: text("token_hash").unique(),
    scopes: text("scopes").notNull(),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_bot_connections_ws_oauth_client").on(table.workspaceId, table.oauthClientId),
    check(
      "chk_bot_connections_credential",
      sql`${table.oauthClientId} IS NOT NULL OR ${table.tokenHash} IS NOT NULL`,
    ),
    check(
      "chk_bot_connections_channel",
      sql`${table.channelType} IN ('mcp_oauth', 'worker_bearer')`,
    ),
    check("chk_bot_connections_status", sql`${table.status} IN ('active', 'paused', 'revoked')`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentTaskId: text("parent_task_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("ready"),
    statusReason: text("status_reason"),
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(true),
    assignedBotId: text("assigned_bot_id").references(() => botConnections.id, {
      onDelete: "set null",
    }),
    retryCount: integer("retry_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_tasks_ws_status").on(table.workspaceId, table.status, table.updatedAt),
    check(
      "chk_tasks_status",
      sql`${table.status} IN ('ready', 'running', 'waiting_human', 'done', 'blocked', 'failed')`,
    ),
  ],
);

export const workLeases = sqliteTable(
  "work_leases",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => botConnections.id, { onDelete: "cascade" }),
    leaseToken: text("lease_token").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_work_leases_expires").on(table.expiresAt)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdByBotId: text("created_by_bot_id")
      .notNull()
      .references(() => botConnections.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    contentOrUrl: text("content_or_url").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_artifacts_ws_task").on(table.workspaceId, table.taskId)],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    proposerBotId: text("proposer_bot_id")
      .notNull()
      .references(() => botConnections.id, { onDelete: "cascade" }),
    cardType: text("card_type").notNull(),
    selectionMode: text("selection_mode").notNull().default("binary"),
    optionsJson: text("options_json"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    onAcceptEffect: text("on_accept_effect").notNull(),
    onDeclineEffect: text("on_decline_effect").notNull(),
    onDeclinePolicy: text("on_decline_policy").notNull().default("revise"),
    factorsJson: text("factors_json").notNull().default("[]"),
    targetTaskVersion: integer("target_task_version").notNull(),
    targetArtifactId: text("target_artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    targetArtifactVersion: integer("target_artifact_version"),
    payloadHash: text("payload_hash").notNull(),
    supersededById: text("superseded_by_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_proposals_ws_task").on(table.workspaceId, table.taskId),
    check("chk_proposals_card_type", sql`${table.cardType} IN ('policy', 'choice', 'deliverable')`),
    check(
      "chk_proposals_selection_mode",
      sql`${table.selectionMode} IN ('binary', 'single', 'multi')`,
    ),
    check("chk_proposals_decline_policy", sql`${table.onDeclinePolicy} IN ('revise', 'block')`),
  ],
);

export const decisionCards = sqliteTable(
  "decision_cards",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    selectionGroupId: text("selection_group_id"),
    status: text("status").notNull().default("pending"),
    provisionalResult: text("provisional_result"),
    provisionalUntil: integer("provisional_until"),
    expiresAt: integer("expires_at"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_decision_cards_ws_status").on(table.workspaceId, table.status, table.createdAt),
    index("idx_decision_cards_group").on(table.selectionGroupId),
    uniqueIndex("idx_decision_cards_single_group_accept")
      .on(table.selectionGroupId)
      .where(
        sql`${table.selectionGroupId} IS NOT NULL AND (${table.status} = 'accepted' OR (${table.status} = 'provisional' AND ${table.provisionalResult} = 'accepted'))`,
      ),
    check(
      "chk_decision_cards_status",
      sql`${table.status} IN ('pending', 'provisional', 'accepted', 'declined', 'deferred', 'superseded', 'closed', 'expired')`,
    ),
    check(
      "chk_decision_cards_provisional_result",
      sql`${table.provisionalResult} IS NULL OR ${table.provisionalResult} IN ('accepted', 'declined')`,
    ),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => decisionCards.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    result: text("result").notNull(),
    selectedOptionIdsJson: text("selected_option_ids_json"),
    status: text("status").notNull(),
    cardVersion: integer("card_version").notNull(),
    finalizedTaskVersion: integer("finalized_task_version"),
    provisionalAt: integer("provisional_at").notNull(),
    finalizedAt: integer("finalized_at"),
    canceledAt: integer("canceled_at"),
    consumedAt: integer("consumed_at"),
  },
  (table) => [
    uniqueIndex("idx_decisions_active_per_card")
      .on(table.cardId)
      .where(sql`${table.status} IN ('provisional', 'finalized')`),
    index("idx_decisions_unconsumed").on(table.status, table.consumedAt),
    check("chk_decisions_result", sql`${table.result} IN ('accepted', 'declined')`),
    check("chk_decisions_status", sql`${table.status} IN ('provisional', 'canceled', 'finalized')`),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    requestId: text("request_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_events_workspace_action_created").on(
      table.workspaceId,
      table.action,
      table.createdAt,
    ),
    index("idx_events_workspace_created").on(table.workspaceId, table.createdAt),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    operation: text("operation").notNull(),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.actorType,
        table.actorId,
        table.operation,
        table.requestId,
      ],
    }),
  ],
);

export const batchGuard = sqliteTable(
  "_batch_guard",
  {
    ok: integer("ok").notNull(),
  },
  (table) => [check("chk_batch_guard_ok", sql`${table.ok} = 1`)],
);

export const schema = {
  user,
  session,
  account,
  verification,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
  workspaces,
  botConnections,
  tasks,
  workLeases,
  artifacts,
  proposals,
  decisionCards,
  decisions,
  events,
  idempotencyKeys,
  batchGuard,
};

export type AppSchema = typeof schema;
