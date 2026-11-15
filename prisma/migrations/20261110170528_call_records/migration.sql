-- CreateTable
CREATE TABLE "call_record" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "args_hash" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result_id" TEXT,
    "answer" BLOB,
    "request_id" TEXT,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" DATETIME,
    CONSTRAINT "call_record_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "call_record_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "call_record_token_id_args_hash_idx" ON "call_record"("token_id", "args_hash");

-- CreateIndex
CREATE INDEX "call_record_token_id_server_id_tool_name_started_at_idx" ON "call_record"("token_id", "server_id", "tool_name", "started_at");

-- CreateIndex
CREATE INDEX "call_record_started_at_idx" ON "call_record"("started_at");
