-- CreateTable
CREATE TABLE "api_token_tool_access" (
    "token_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,

    PRIMARY KEY ("token_id", "server_id", "tool_name"),
    CONSTRAINT "api_token_tool_access_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_token_tool_access_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "permission_request" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "server_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "args_ciphertext" BLOB NOT NULL,
    "args_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "via" TEXT,
    "result_ciphertext" BLOB,
    "result_is_error" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "decided_at" DATETIME,
    CONSTRAINT "permission_request_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "permission_request_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "permission_request_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "permission_request_token_id_args_hash_idx" ON "permission_request"("token_id", "args_hash");

-- CreateIndex
CREATE INDEX "permission_request_vault_id_status_idx" ON "permission_request"("vault_id", "status");

-- CreateIndex
CREATE INDEX "permission_request_expires_at_idx" ON "permission_request"("expires_at");
