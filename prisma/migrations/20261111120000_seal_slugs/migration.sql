-- A server's and a definition's short name are sealed under the vault's
-- key (#96): meta holds the name, found by its keyed hash in slug_key. The
-- plain columns stay for rows from before, until each vault's rows are
-- sealed; sealed rows hold "" there, so the hash is what is unique.
ALTER TABLE "mcp_server" ADD COLUMN "slug_key" TEXT;
ALTER TABLE "server_definition" ADD COLUMN "slug_key" TEXT;

DROP INDEX "mcp_server_vault_id_slug_key";
CREATE UNIQUE INDEX "mcp_server_vault_id_slug_key_key" ON "mcp_server"("vault_id", "slug_key");

DROP INDEX "server_definition_vault_id_slug_key";
CREATE UNIQUE INDEX "server_definition_vault_id_slug_key_key" ON "server_definition"("vault_id", "slug_key");
