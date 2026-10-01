-- Endpoint edits and schema URLs an assistant proposed.
--
-- openapi_spec.patches: edits (a JSON Patch) applied to the schema before
-- tools are generated. None for every existing endpoint.
-- mcp_server.spec_url_from_assistant: the schema URL came from an
-- assistant's registration, so a background re-read does not take a changed
-- document. Off for every existing endpoint.
--
-- Plain column additions: Prisma's own diff would rebuild both tables, and a
-- DROP inside the boot migrator's transaction cascades to everything that
-- references them.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "spec_url_from_assistant" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "openapi_spec" ADD COLUMN "patches" TEXT NOT NULL DEFAULT '[]';
