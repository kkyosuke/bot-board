-- bot-board initial SQLite / Cloudflare D1 migration
-- Matches src/db/schema.ts and docs/data-and-state.md

CREATE TABLE IF NOT EXISTS `_batch_guard` (
  `ok` INTEGER NOT NULL CONSTRAINT `chk_batch_guard_ok` CHECK (`ok` = 1)
);

-- Better Auth + @better-auth/mcp tables
CREATE TABLE IF NOT EXISTS `user` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `email` TEXT NOT NULL UNIQUE,
  `emailVerified` INTEGER NOT NULL DEFAULT 0,
  `image` TEXT,
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `session` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `expiresAt` INTEGER NOT NULL,
  `token` TEXT NOT NULL UNIQUE,
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL,
  `ipAddress` TEXT,
  `userAgent` TEXT,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `account` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `accountId` TEXT NOT NULL,
  `providerId` TEXT NOT NULL,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `accessToken` TEXT,
  `refreshToken` TEXT,
  `idToken` TEXT,
  `accessTokenExpiresAt` INTEGER,
  `refreshTokenExpiresAt` INTEGER,
  `scope` TEXT,
  `password` TEXT,
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `verification` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `identifier` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `expiresAt` INTEGER NOT NULL,
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `jwks` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `publicKey` TEXT NOT NULL,
  `privateKey` TEXT NOT NULL,
  `createdAt` INTEGER NOT NULL,
  `expiresAt` INTEGER,
  `alg` TEXT,
  `crv` TEXT
);

CREATE TABLE IF NOT EXISTS `oauthClient` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `clientId` TEXT NOT NULL UNIQUE,
  `clientSecret` TEXT,
  `clientDiscoveryId` TEXT,
  `disabled` INTEGER,
  `skipConsent` INTEGER,
  `enableEndSession` INTEGER,
  `subjectType` TEXT,
  `scopes` TEXT,
  `clientCredentialsScopes` TEXT,
  `userId` TEXT REFERENCES `user`(`id`) ON DELETE CASCADE,
  `createdAt` INTEGER,
  `updatedAt` INTEGER,
  `name` TEXT,
  `uri` TEXT,
  `icon` TEXT,
  `contacts` TEXT,
  `tos` TEXT,
  `policy` TEXT,
  `softwareId` TEXT,
  `softwareVersion` TEXT,
  `softwareStatement` TEXT,
  `redirectUris` TEXT NOT NULL,
  `postLogoutRedirectUris` TEXT,
  `backchannelLogoutUri` TEXT,
  `backchannelLogoutSessionRequired` INTEGER,
  `tokenEndpointAuthMethod` TEXT,
  `applicationType` TEXT,
  `jwks` TEXT,
  `jwksUri` TEXT,
  `grantTypes` TEXT,
  `responseTypes` TEXT,
  `requirePKCE` INTEGER,
  `dpopBoundAccessTokens` INTEGER,
  `referenceId` TEXT,
  `metadata` TEXT
);

CREATE TABLE IF NOT EXISTS `oauthResource` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `identifier` TEXT NOT NULL UNIQUE,
  `name` TEXT NOT NULL,
  `accessTokenTtl` INTEGER,
  `refreshTokenTtl` INTEGER,
  `signingAlgorithm` TEXT,
  `signingKeyId` TEXT,
  `allowedScopes` TEXT,
  `customClaims` TEXT,
  `dpopBoundAccessTokensRequired` INTEGER,
  `disabled` INTEGER,
  `createdAt` INTEGER,
  `updatedAt` INTEGER,
  `policyVersion` INTEGER,
  `metadata` TEXT
);

CREATE TABLE IF NOT EXISTS `oauthClientResource` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `clientId` TEXT NOT NULL REFERENCES `oauthClient`(`clientId`) ON DELETE CASCADE,
  `resourceId` TEXT NOT NULL REFERENCES `oauthResource`(`identifier`) ON DELETE CASCADE,
  `metadata` TEXT,
  `createdAt` INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_oauth_client_resource_pair`
  ON `oauthClientResource` (`clientId`, `resourceId`);

CREATE TABLE IF NOT EXISTS `oauthRefreshToken` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `token` TEXT NOT NULL UNIQUE,
  `clientId` TEXT NOT NULL REFERENCES `oauthClient`(`clientId`) ON DELETE CASCADE,
  `sessionId` TEXT REFERENCES `session`(`id`) ON DELETE SET NULL,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `referenceId` TEXT,
  `authorizationCodeId` TEXT,
  `resources` TEXT,
  `requestedUserInfoClaims` TEXT,
  `expiresAt` INTEGER,
  `createdAt` INTEGER,
  `revoked` INTEGER,
  `rotatedAt` INTEGER,
  `rotationReplayResponse` TEXT,
  `rotationReplayExpiresAt` INTEGER,
  `authTime` INTEGER,
  `confirmation` TEXT,
  `scopes` TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS `oauthAccessToken` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `token` TEXT UNIQUE,
  `clientId` TEXT NOT NULL REFERENCES `oauthClient`(`clientId`) ON DELETE CASCADE,
  `sessionId` TEXT REFERENCES `session`(`id`) ON DELETE SET NULL,
  `userId` TEXT REFERENCES `user`(`id`) ON DELETE CASCADE,
  `referenceId` TEXT,
  `authorizationCodeId` TEXT,
  `resources` TEXT,
  `requestedUserInfoClaims` TEXT,
  `refreshId` TEXT REFERENCES `oauthRefreshToken`(`id`) ON DELETE SET NULL,
  `expiresAt` INTEGER,
  `createdAt` INTEGER,
  `revoked` INTEGER,
  `confirmation` TEXT,
  `scopes` TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS `oauthConsent` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `clientId` TEXT NOT NULL REFERENCES `oauthClient`(`clientId`) ON DELETE CASCADE,
  `userId` TEXT REFERENCES `user`(`id`) ON DELETE CASCADE,
  `referenceId` TEXT,
  `resources` TEXT,
  `requestedUserInfoClaims` TEXT,
  `scopes` TEXT NOT NULL,
  `createdAt` INTEGER,
  `updatedAt` INTEGER
);

CREATE TABLE IF NOT EXISTS `oauthClientAssertion` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `expiresAt` INTEGER NOT NULL
);

-- Domain tables
CREATE TABLE IF NOT EXISTS `workspaces` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `owner_user_id` TEXT NOT NULL UNIQUE REFERENCES `user`(`id`) ON DELETE CASCADE,
  `goal` TEXT NOT NULL DEFAULT '',
  `allowed_scope` TEXT NOT NULL DEFAULT '',
  `budget_limit` TEXT NOT NULL,
  `is_paused` INTEGER NOT NULL DEFAULT 0,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `bot_connections` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `display_name` TEXT NOT NULL,
  `channel_type` TEXT NOT NULL CONSTRAINT `chk_bot_connections_channel` CHECK (`channel_type` IN ('mcp_oauth', 'worker_bearer')),
  `oauth_client_id` TEXT,
  `token_hash` TEXT UNIQUE,
  `scopes` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'active' CONSTRAINT `chk_bot_connections_status` CHECK (`status` IN ('active', 'paused', 'revoked')),
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  CONSTRAINT `chk_bot_connections_credential` CHECK (`oauth_client_id` IS NOT NULL OR `token_hash` IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_bot_connections_ws_oauth_client`
  ON `bot_connections` (`workspace_id`, `oauth_client_id`);

CREATE TABLE IF NOT EXISTS `tasks` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `parent_task_id` TEXT,
  `title` TEXT NOT NULL,
  `description` TEXT NOT NULL DEFAULT '',
  `status` TEXT NOT NULL DEFAULT 'ready' CONSTRAINT `chk_tasks_status` CHECK (`status` IN ('ready', 'running', 'waiting_human', 'done', 'blocked', 'failed')),
  `status_reason` TEXT,
  `requires_approval` INTEGER NOT NULL DEFAULT 1,
  `assigned_bot_id` TEXT REFERENCES `bot_connections`(`id`) ON DELETE SET NULL,
  `retry_count` INTEGER NOT NULL DEFAULT 0,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_tasks_ws_status`
  ON `tasks` (`workspace_id`, `status`, `updated_at`);

CREATE TABLE IF NOT EXISTS `work_leases` (
  `task_id` TEXT PRIMARY KEY NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `bot_id` TEXT NOT NULL REFERENCES `bot_connections`(`id`) ON DELETE CASCADE,
  `lease_token` TEXT NOT NULL,
  `expires_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_work_leases_expires`
  ON `work_leases` (`expires_at`);

CREATE TABLE IF NOT EXISTS `artifacts` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `task_id` TEXT NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `created_by_bot_id` TEXT NOT NULL REFERENCES `bot_connections`(`id`) ON DELETE CASCADE,
  `title` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `summary` TEXT NOT NULL,
  `content_or_url` TEXT NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_artifacts_ws_task`
  ON `artifacts` (`workspace_id`, `task_id`);

CREATE TABLE IF NOT EXISTS `proposals` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `task_id` TEXT NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `proposer_bot_id` TEXT NOT NULL REFERENCES `bot_connections`(`id`) ON DELETE CASCADE,
  `card_type` TEXT NOT NULL CONSTRAINT `chk_proposals_card_type` CHECK (`card_type` IN ('policy', 'choice', 'deliverable')),
  `selection_mode` TEXT NOT NULL DEFAULT 'binary' CONSTRAINT `chk_proposals_selection_mode` CHECK (`selection_mode` IN ('binary', 'single', 'multi')),
  `options_json` TEXT,
  `title` TEXT NOT NULL,
  `summary` TEXT NOT NULL,
  `on_accept_effect` TEXT NOT NULL,
  `on_decline_effect` TEXT NOT NULL,
  `on_decline_policy` TEXT NOT NULL DEFAULT 'revise' CONSTRAINT `chk_proposals_decline_policy` CHECK (`on_decline_policy` IN ('revise', 'block')),
  `factors_json` TEXT NOT NULL DEFAULT '[]',
  `target_task_version` INTEGER NOT NULL,
  `target_artifact_id` TEXT REFERENCES `artifacts`(`id`) ON DELETE SET NULL,
  `target_artifact_version` INTEGER,
  `payload_hash` TEXT NOT NULL,
  `superseded_by_id` TEXT,
  `created_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_proposals_ws_task`
  ON `proposals` (`workspace_id`, `task_id`);

CREATE TABLE IF NOT EXISTS `decision_cards` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `proposal_id` TEXT NOT NULL REFERENCES `proposals`(`id`) ON DELETE CASCADE,
  `selection_group_id` TEXT,
  `status` TEXT NOT NULL DEFAULT 'pending' CONSTRAINT `chk_decision_cards_status` CHECK (`status` IN ('pending', 'provisional', 'accepted', 'declined', 'deferred', 'superseded', 'closed', 'expired')),
  `provisional_result` TEXT CONSTRAINT `chk_decision_cards_provisional_result` CHECK (`provisional_result` IS NULL OR `provisional_result` IN ('accepted', 'declined')),
  `provisional_until` INTEGER,
  `expires_at` INTEGER,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_decision_cards_ws_status`
  ON `decision_cards` (`workspace_id`, `status`, `created_at`);

CREATE INDEX IF NOT EXISTS `idx_decision_cards_group`
  ON `decision_cards` (`selection_group_id`);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_decision_cards_single_group_accept`
  ON `decision_cards` (`selection_group_id`)
  WHERE `selection_group_id` IS NOT NULL
    AND (`status` = 'accepted' OR (`status` = 'provisional' AND `provisional_result` = 'accepted'));

CREATE TABLE IF NOT EXISTS `decisions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `card_id` TEXT NOT NULL REFERENCES `decision_cards`(`id`) ON DELETE CASCADE,
  `actor_user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `result` TEXT NOT NULL CONSTRAINT `chk_decisions_result` CHECK (`result` IN ('accepted', 'declined')),
  `selected_option_ids_json` TEXT,
  `status` TEXT NOT NULL CONSTRAINT `chk_decisions_status` CHECK (`status` IN ('provisional', 'canceled', 'finalized')),
  `card_version` INTEGER NOT NULL,
  `finalized_task_version` INTEGER,
  `provisional_at` INTEGER NOT NULL,
  `finalized_at` INTEGER,
  `canceled_at` INTEGER,
  `consumed_at` INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_decisions_active_per_card`
  ON `decisions` (`card_id`)
  WHERE `status` IN ('provisional', 'finalized');

CREATE INDEX IF NOT EXISTS `idx_decisions_unconsumed`
  ON `decisions` (`status`, `consumed_at`);

CREATE TABLE IF NOT EXISTS `events` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `actor_type` TEXT NOT NULL,
  `actor_id` TEXT NOT NULL,
  `entity_type` TEXT NOT NULL,
  `entity_id` TEXT NOT NULL,
  `action` TEXT NOT NULL,
  `payload_json` TEXT NOT NULL DEFAULT '{}',
  `request_id` TEXT,
  `created_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_events_workspace_action_created`
  ON `events` (`workspace_id`, `action`, `created_at`);

CREATE INDEX IF NOT EXISTS `idx_events_workspace_created`
  ON `events` (`workspace_id`, `created_at`);

CREATE TABLE IF NOT EXISTS `idempotency_keys` (
  `workspace_id` TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `actor_type` TEXT NOT NULL,
  `actor_id` TEXT NOT NULL,
  `operation` TEXT NOT NULL,
  `request_id` TEXT NOT NULL,
  `input_hash` TEXT NOT NULL,
  `response_json` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  PRIMARY KEY (`workspace_id`, `actor_type`, `actor_id`, `operation`, `request_id`)
);
