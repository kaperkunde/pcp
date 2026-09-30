-- CreateTable
CREATE TABLE "vault" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "key_grant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lookup_hash" TEXT,
    "kdf" TEXT NOT NULL,
    "kdf_params" TEXT NOT NULL,
    "wrapped_dek" BLOB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    CONSTRAINT "key_grant_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    CONSTRAINT "session_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "session_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "key_grant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "allow_all_servers" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" DATETIME,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    CONSTRAINT "api_token_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_token_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "key_grant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_token_server" (
    "token_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,

    PRIMARY KEY ("token_id", "server_id"),
    CONSTRAINT "api_token_server_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_token_server_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "secret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'text',
    "ciphertext" BLOB NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "last_used_at" DATETIME,
    CONSTRAINT "secret_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mcp_server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "auth_type" TEXT NOT NULL DEFAULT 'none',
    "auth_header_name" TEXT,
    "auth_value_template" TEXT,
    "auth_secret_id" TEXT,
    "oauth_client_id" TEXT,
    "oauth_client_secret_id" TEXT,
    "oauth_scope" TEXT,
    "oauth_tokens_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "status_message" TEXT NOT NULL DEFAULT '',
    "last_synced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "mcp_server_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mcp_server_auth_secret_id_fkey" FOREIGN KEY ("auth_secret_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "mcp_server_oauth_client_secret_id_fkey" FOREIGN KEY ("oauth_client_secret_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "mcp_server_oauth_tokens_id_fkey" FOREIGN KEY ("oauth_tokens_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mcp_tool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "description_override" TEXT,
    "input_schema" TEXT NOT NULL,
    "annotations" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "mcp_tool_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauth_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "code_verifier" BLOB NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "oauth_state_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "setting" (
    "vault_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    PRIMARY KEY ("vault_id", "key"),
    CONSTRAINT "setting_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "key_grant_lookup_hash_key" ON "key_grant"("lookup_hash");

-- CreateIndex
CREATE INDEX "key_grant_vault_id_kind_idx" ON "key_grant"("vault_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "session_grant_id_key" ON "session"("grant_id");

-- CreateIndex
CREATE INDEX "session_vault_id_idx" ON "session"("vault_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_grant_id_key" ON "api_token"("grant_id");

-- CreateIndex
CREATE INDEX "api_token_vault_id_idx" ON "api_token"("vault_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_vault_id_name_key" ON "secret"("vault_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_vault_id_slug_key" ON "mcp_server"("vault_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tool_server_id_name_key" ON "mcp_tool"("server_id", "name");
