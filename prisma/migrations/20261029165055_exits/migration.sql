-- Exits (lib/core/exits/): ways out to the internet from an SSH server, or
-- (later) a VPN container PCP runs on one. Levels per token are web_fetch_rule
-- rows of kind "exit", so nothing else changes.
--
-- A plain addition: a new table, no rebuild.

-- CreateTable
CREATE TABLE "exit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "service_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "exit_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "exit_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "exit_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "exit_server_id_idx" ON "exit"("server_id");

-- CreateIndex
CREATE INDEX "exit_service_id_idx" ON "exit"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "exit_vault_id_name_key" ON "exit"("vault_id", "name");
