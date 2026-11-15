-- CreateIndex
CREATE INDEX "permission_request_token_id_decided_at_idx" ON "permission_request"("token_id", "decided_at");
