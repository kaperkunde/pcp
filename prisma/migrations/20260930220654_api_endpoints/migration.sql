-- API endpoints: an mcp_server row of kind "openapi" is an HTTP API
-- described by an OpenAPI schema.
--
-- Plain column additions on purpose. Prisma's own diff rebuilds the table
-- (CREATE new_mcp_server, copy, DROP mcp_server), and lib/core/migrate.ts
-- runs each migration inside a transaction, where PRAGMA foreign_keys=OFF
-- does nothing: the DROP would cascade and delete every tool, token scope
-- and OAuth state.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'mcp';
ALTER TABLE "mcp_server" ADD COLUMN "spec_source" TEXT;
ALTER TABLE "mcp_server" ADD COLUMN "spec_url" TEXT;
ALTER TABLE "mcp_server" ADD COLUMN "read_only" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "mcp_tool" ADD COLUMN "operation" TEXT;

-- CreateTable
CREATE TABLE "openapi_spec" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "fetched_at" DATETIME NOT NULL,
    CONSTRAINT "openapi_spec_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
