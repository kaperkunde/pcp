-- A call the owner allowed once keeps, for a short while, the answer a
-- program would have been handed (encrypted), so the same token's identical
-- call is answered with that run instead of asking the owner again
-- (lib/core/permissions.ts reuseExecuted). Plain additions: two nullable
-- columns, no rebuild.

-- AlterTable
ALTER TABLE "permission_request" ADD COLUMN "result_json_ciphertext" BLOB;
ALTER TABLE "permission_request" ADD COLUMN "reuse_until" DATETIME;
