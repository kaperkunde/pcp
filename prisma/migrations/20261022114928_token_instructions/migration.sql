-- instructions: the owner's instructions for one assistant, encrypted under
-- the vault's key ("api_token:<id>"), and instructions_base: the version of
-- PCP's suggested instructions they were copied or merged from. Both null
-- for every existing token: nothing is copied in until the owner saves.
--
-- Plain column additions: a rebuild of api_token would drop it inside the
-- boot migrator's transaction and cascade to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "instructions" BLOB;
ALTER TABLE "api_token" ADD COLUMN "instructions_base" INTEGER;
