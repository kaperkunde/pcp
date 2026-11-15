-- What a server is and where it is (its name, description, address,
-- logins, what PCP found out of it, its status message) and a definition's
-- name and description are sealed under the vault's key (#96). The plain
-- columns stay for rows from before, until each vault's rows are sealed;
-- a sealed row holds blanks in them.
ALTER TABLE "mcp_server" ADD COLUMN "meta" BLOB;
ALTER TABLE "server_definition" ADD COLUMN "meta" BLOB;
