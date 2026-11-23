-- AlterTable
ALTER TABLE "storage_entry" ADD COLUMN "pass_only" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "tool_result_token_id_pass_only_expires_at_idx" ON "tool_result"("token_id", "pass_only", "expires_at");
