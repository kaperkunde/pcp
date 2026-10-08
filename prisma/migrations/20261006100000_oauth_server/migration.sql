-- PCP's own OAuth authorization server, for assistants that connect to /mcp
-- with a URL and a sign-in instead of a pcp_ token (lib/core/oauth-server/).
--
-- api_token gains the client a token was issued to, as plain column
-- additions: Prisma's own diff for a relation would rebuild api_token, and a
-- DROP inside the boot migrator's transaction cascades to everything that
-- references it. oauth_credential holds the codes, access tokens and
-- refresh tokens (hashes only; the key is in their grants), oauth_client
-- the clients that registered themselves.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "oauth_client_id" TEXT;
ALTER TABLE "api_token" ADD COLUMN "oauth_client_name" TEXT;

-- CreateTable
CREATE TABLE "oauth_credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "grant_id" TEXT,
    "kind" TEXT NOT NULL,
    "lookup_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT,
    "code_challenge" TEXT,
    "resource" TEXT,
    "scope" TEXT,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_credential_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oauth_credential_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oauth_credential_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "key_grant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauth_client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT NOT NULL,
    "client_uri" TEXT,
    "auth_method" TEXT NOT NULL,
    "secret_hash" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credential_grant_id_key" ON "oauth_credential"("grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credential_lookup_hash_key" ON "oauth_credential"("lookup_hash");

-- CreateIndex
CREATE INDEX "oauth_credential_token_id_idx" ON "oauth_credential"("token_id");

-- CreateIndex
CREATE INDEX "oauth_credential_expires_at_idx" ON "oauth_credential"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_client_created_at_idx" ON "oauth_client"("created_at");

