-- Definitions and instances (lib/core/definitions.ts): what servers that
-- are the same thing share, and the owner's own note on a server or skill.
--
-- server_definition holds a shareable server's identity (kind, its own
-- slug and name, the description its instances carry); mcp_server rows
-- point to theirs with definition_id. Every existing MCP server, API
-- endpoint and wrapper becomes the one instance of a definition of its
-- own, with the server's id as the definition's: nothing is merged here,
-- the owner is offered that for endpoints whose schemas are the same.
--
-- Plain column additions: Prisma's own diff would rebuild mcp_server, and
-- a DROP inside the boot migrator's transaction cascades to everything that
-- references it. SQLite takes a REFERENCES clause on an added column whose
-- default is NULL.

-- CreateTable
CREATE TABLE "server_definition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "format_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "server_definition_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "server_definition_vault_id_slug_key" ON "server_definition"("vault_id", "slug");

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "definition_id" TEXT REFERENCES "server_definition" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mcp_server" ADD COLUMN "personal_note" BLOB;

-- CreateIndex
CREATE INDEX "mcp_server_definition_id_idx" ON "mcp_server"("definition_id");

-- AlterTable
ALTER TABLE "skill" ADD COLUMN "personal_note" BLOB;

-- One definition per existing shareable server, named after it. Server
-- slugs are unique in a vault, so these are too.
INSERT INTO "server_definition" ("id", "vault_id", "kind", "slug", "name", "description", "format_version", "created_at", "updated_at")
SELECT "id", "vault_id", "kind", "slug", "name", "description", 1, "created_at", CURRENT_TIMESTAMP
FROM "mcp_server"
WHERE "kind" IN ('mcp', 'openapi', 'wrapper');

UPDATE "mcp_server" SET "definition_id" = "id"
WHERE "kind" IN ('mcp', 'openapi', 'wrapper');
