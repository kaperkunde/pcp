-- What a permission request is about, as a keyed hash (lib/core/permission-fold.ts),
-- so a second change from the same token to the same skill or shared memory
-- folds into the request still waiting, and another token's shows as a
-- conflict. Plain additions: a nullable column and an index, no rebuild.

-- AlterTable
ALTER TABLE "permission_request" ADD COLUMN "target_key" TEXT;

-- CreateIndex
CREATE INDEX "permission_request_vault_id_target_key_idx" ON "permission_request"("vault_id", "target_key");
