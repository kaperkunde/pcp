-- run_code: whether a token may run programs that call its tools through
-- the gateway. Off for every existing token.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild api_token, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "run_code" BOOLEAN NOT NULL DEFAULT false;
