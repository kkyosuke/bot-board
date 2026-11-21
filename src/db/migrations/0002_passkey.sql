-- bot-board passkey authentication migration (@better-auth/passkey)
-- Matches src/db/schema.ts `passkey` table

CREATE TABLE IF NOT EXISTS `passkey` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT,
  `publicKey` TEXT NOT NULL,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `credentialID` TEXT NOT NULL,
  `counter` INTEGER NOT NULL,
  `deviceType` TEXT NOT NULL,
  `backedUp` INTEGER NOT NULL,
  `transports` TEXT,
  `createdAt` INTEGER,
  `aaguid` TEXT
);

CREATE INDEX IF NOT EXISTS `idx_passkey_user_id` ON `passkey`(`userId`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_passkey_credential_id` ON `passkey`(`credentialID`);
