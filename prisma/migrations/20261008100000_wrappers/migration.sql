-- Wrappers: servers whose tools are programs the owner approved, over the
-- vault's other tools (lib/core/wrappers/). A new table for what the owner
-- approved, and whether a token may propose wrappers, off for every
-- existing token.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild api_token, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "manage_wrappers" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "wrapper_spec" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "definition" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "wrapper_spec_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
