-- A secret's name and description are sealed under the vault's key (#96):
-- meta holds them, the name is found by its keyed hash. The plain columns
-- stay for rows from before, until each vault's rows are sealed.
ALTER TABLE "secret" ADD COLUMN "meta" BLOB;
ALTER TABLE "secret" ADD COLUMN "name_key" TEXT;

-- Sealed rows hold "" as their plain name: unique by the hash instead.
DROP INDEX "secret_vault_id_name_key";
CREATE UNIQUE INDEX "secret_vault_id_name_key_key" ON "secret"("vault_id", "name_key");
