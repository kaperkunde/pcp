-- Endpoint management through the gateway.
--
-- api_token.manage_endpoints: whether a token may register and change API
-- endpoints. Off for every existing token.
-- mcp_server.public_only: refuse private, loopback and link-local addresses.
-- Off for every existing endpoint, which the owner added themselves.
--
-- Plain column additions, as in the migration before this one: Prisma's own
-- diff would rebuild the table, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "manage_endpoints" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "public_only" BOOLEAN NOT NULL DEFAULT false;
