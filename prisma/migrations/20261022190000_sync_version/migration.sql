-- The version of a server's, endpoint's or wrapper's document in a linked
-- repository (lib/core/repos/). A plain column addition: Prisma's own diff
-- would rebuild mcp_server, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "sync_version" INTEGER;
