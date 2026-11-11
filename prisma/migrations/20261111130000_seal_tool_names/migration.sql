-- A tool's name is sealed under the vault's key (#96): about holds it, and
-- it is found by a keyed hash of the server's id and the name in name_key.
-- The plain column stays for rows from before, until each vault's rows are
-- sealed; sealed rows hold "" there, so the hash is what is unique.
ALTER TABLE "mcp_tool" ADD COLUMN "name_key" TEXT;

DROP INDEX "mcp_tool_server_id_name_key";
CREATE UNIQUE INDEX "mcp_tool_server_id_name_key_key" ON "mcp_tool"("server_id", "name_key");
