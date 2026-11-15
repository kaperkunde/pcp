-- The last descriptive values of #96 are sealed under the vault's key: an
-- exit's name and label (found by a keyed hash, name_key, unique in the
-- vault instead of the plain name), a store's folder and login
-- (storage_root.sealed), and the client an API token is for
-- (api_token.client_meta). Rows from before are converted by the first
-- request that holds the key. Columns are added and one unique index is
-- swapped; no table is rebuilt.
-- DropIndex
DROP INDEX "exit_vault_id_name_key";

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "client_meta" BLOB;

-- AlterTable
ALTER TABLE "exit" ADD COLUMN "about" BLOB;
ALTER TABLE "exit" ADD COLUMN "name_key" TEXT;

-- AlterTable
ALTER TABLE "storage_root" ADD COLUMN "sealed" BLOB;

-- CreateIndex
CREATE UNIQUE INDEX "exit_vault_id_name_key_key" ON "exit"("vault_id", "name_key");

