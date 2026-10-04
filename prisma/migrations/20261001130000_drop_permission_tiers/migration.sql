-- PCP asks the owner by link only, so tokens no longer choose how.
-- A plain DROP COLUMN, not Prisma's table rebuild: migrations run in a
-- transaction with foreign keys on, where the rebuild's DROP TABLE would
-- cascade to every token's servers, tool access and permission requests.
ALTER TABLE "api_token" DROP COLUMN "permission_tiers";
