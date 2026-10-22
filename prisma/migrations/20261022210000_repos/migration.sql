-- Linked repositories (lib/core/repos/): which GitHub repositories the
-- owner shares items through, and which items are linked to a file or
-- folder there and how they sync. What names the owner's things is one
-- ciphertext under the vault's key ("repo:<id>", "repo_item:<id>").
--
-- New tables only: nothing that exists is rebuilt.

-- CreateTable
CREATE TABLE "repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "ciphertext" BLOB NOT NULL,
    "trust" TEXT NOT NULL DEFAULT 'untrusted',
    "access" TEXT NOT NULL DEFAULT 'read',
    "secret_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repo_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "repo_item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo_id" TEXT NOT NULL,
    "item_kind" TEXT NOT NULL,
    "skill_id" TEXT,
    "server_id" TEXT,
    "ciphertext" BLOB NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'off',
    "bidirectional" BOOLEAN NOT NULL DEFAULT false,
    "last_sync_at" DATETIME,
    "state" TEXT NOT NULL DEFAULT 'ok',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repo_item_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_item_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_item_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "repo_vault_id_idx" ON "repo"("vault_id");

-- CreateIndex
CREATE UNIQUE INDEX "repo_item_skill_id_key" ON "repo_item"("skill_id");

-- CreateIndex
CREATE UNIQUE INDEX "repo_item_server_id_key" ON "repo_item"("server_id");

-- CreateIndex
CREATE INDEX "repo_item_repo_id_idx" ON "repo_item"("repo_id");
