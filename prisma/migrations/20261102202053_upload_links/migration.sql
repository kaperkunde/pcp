-- AlterTable
ALTER TABLE "file_link" ADD COLUMN "upload_link_id" TEXT;

-- CreateTable
CREATE TABLE "upload_link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "purpose" BLOB NOT NULL,
    "max_files" INTEGER NOT NULL,
    "result_ids" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accept_until" DATETIME NOT NULL,
    "first_at" DATETIME,
    "closed_at" DATETIME,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "upload_link_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "upload_link_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "upload_link_secret_hash_key" ON "upload_link"("secret_hash");

-- CreateIndex
CREATE INDEX "upload_link_token_id_idx" ON "upload_link"("token_id");

-- CreateIndex
CREATE INDEX "upload_link_expires_at_idx" ON "upload_link"("expires_at");

-- CreateIndex
CREATE INDEX "file_link_upload_link_id_idx" ON "file_link"("upload_link_id");
