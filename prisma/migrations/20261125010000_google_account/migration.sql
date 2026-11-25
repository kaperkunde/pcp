-- CreateTable
CREATE TABLE "oauth_account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "meta" BLOB NOT NULL,
    "client_secret_id" TEXT,
    "tokens_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "connected_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "oauth_account_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oauth_account_client_secret_id_fkey" FOREIGN KEY ("client_secret_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "oauth_account_tokens_id_fkey" FOREIGN KEY ("tokens_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauth_account_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "oauth_account_state_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "oauth_account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_account_vault_id_provider_key" ON "oauth_account"("vault_id", "provider");

-- AlterTable: a server that signs in through an account (additive: a plain
-- column added in place, never a table rebuild, which would cascade).
ALTER TABLE "mcp_server" ADD COLUMN "account_id" TEXT REFERENCES "oauth_account" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
