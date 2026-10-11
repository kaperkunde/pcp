-- Calendar accounts: servers of kind "caldav" (lib/core/caldav/).
--
-- mcp_server.dav_home_url: the calendar home the server named when PCP last
-- found it. Empty for every existing server.
--
-- A plain column addition, as in the mail migration: Prisma's own diff would
-- rebuild the table, and a DROP inside the boot migrator's transaction
-- cascades to everything that references it.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "dav_home_url" TEXT;
