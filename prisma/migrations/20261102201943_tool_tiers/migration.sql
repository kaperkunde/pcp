-- The owner's tier for a tool (lib/core/tool-tiers.ts): Read, Write or
-- Destructive in place of what its annotations say, kept per definition
-- (shared by its instances) or, for a server without one, per server.
--
-- A plain addition: a new table, no rebuild.

-- CreateTable
CREATE TABLE "tool_tier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "definition_id" TEXT,
    "server_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "seen_tier" TEXT,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "tool_tier_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tool_tier_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "server_definition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tool_tier_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "tool_tier_vault_id_idx" ON "tool_tier"("vault_id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_tier_definition_id_tool_name_key" ON "tool_tier"("definition_id", "tool_name");

-- CreateIndex
CREATE UNIQUE INDEX "tool_tier_server_id_tool_name_key" ON "tool_tier"("server_id", "tool_name");
