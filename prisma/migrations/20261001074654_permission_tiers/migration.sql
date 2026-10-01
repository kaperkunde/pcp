-- How PCP may ask the owner about a token's calls.
--
-- api_token.permission_tiers: a comma-separated subset of app | form | url;
-- the link is always on. Every existing token keeps all three, which is how
-- PCP behaved before.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild the table, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "permission_tiers" TEXT NOT NULL DEFAULT 'app,form,url';
