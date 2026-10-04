-- Long tool answers kept for read_result (lib/core/tool-results.ts): the
-- text is encrypted under the vault's data key, readable only by the token
-- whose call produced it, and pruned a day after it was kept. A new table,
-- so nothing existing is rebuilt.

-- CreateTable
CREATE TABLE "tool_result" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "server_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "length" INTEGER NOT NULL,
    "ciphertext" BLOB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "tool_result_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tool_result_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tool_result_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "tool_result_token_id_created_at_idx" ON "tool_result"("token_id", "created_at");

-- CreateIndex
CREATE INDEX "tool_result_expires_at_idx" ON "tool_result"("expires_at");
