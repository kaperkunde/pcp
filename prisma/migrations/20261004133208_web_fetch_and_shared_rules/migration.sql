-- Web fetch, and tool levels for all tokens at once.
--
-- api_token.web_fetch: whether a token may use the web_fetch tool. Off for
-- every existing token.
-- vault_tool_access: a tool's level for every token ("All tokens" on a
-- token's page). A token's own level in api_token_tool_access wins over it.
-- web_fetch_rule: the levels web_fetch follows, per method and per site,
-- for one token or for all of them.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild api_token, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "web_fetch" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "vault_tool_access" (
    "vault_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,

    PRIMARY KEY ("server_id", "tool_name"),
    CONSTRAINT "vault_tool_access_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "vault_tool_access_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "web_fetch_rule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "access" TEXT,
    "added_by" TEXT NOT NULL DEFAULT 'assistant',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "last_fetched_at" DATETIME,
    CONSTRAINT "web_fetch_rule_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "web_fetch_rule_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "vault_tool_access_vault_id_idx" ON "vault_tool_access"("vault_id");

-- CreateIndex
CREATE INDEX "web_fetch_rule_token_id_idx" ON "web_fetch_rule"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_fetch_rule_vault_id_scope_kind_key_key" ON "web_fetch_rule"("vault_id", "scope", "kind", "key");
