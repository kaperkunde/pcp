-- share_files: whether a token may move files between PCP and the
-- assistant's own computer by link (share_result, receive_file). Off for
-- every existing token. file_link: those links.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild api_token, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "share_files" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "file_link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "result_id" TEXT NOT NULL,
    "name" TEXT,
    "media_type" TEXT NOT NULL,
    "length" INTEGER NOT NULL DEFAULT 0,
    "wrapped_key" BLOB,
    "ciphertext" BLOB,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "max_uses" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "received_at" DATETIME,
    CONSTRAINT "file_link_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "file_link_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "file_link_secret_hash_key" ON "file_link"("secret_hash");

-- CreateIndex
CREATE INDEX "file_link_token_id_result_id_idx" ON "file_link"("token_id", "result_id");

-- CreateIndex
CREATE INDEX "file_link_expires_at_idx" ON "file_link"("expires_at");
