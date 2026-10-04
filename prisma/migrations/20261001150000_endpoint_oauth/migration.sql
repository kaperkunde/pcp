-- OAuth for API endpoints.
--
-- mcp_server.oauth_authorization_url / oauth_token_url: for an API endpoint
-- that signs in with OAuth, where the owner signs in and where PCP exchanges
-- the code and renews the token. Read from the schema's oauth2 flow when the
-- owner agrees, and kept: a later schema never moves them, so the client
-- secret only ever goes where the owner was shown. Null for MCP servers,
-- which discover them.
--
-- Plain column additions, as in 20261001084535_endpoint_edits.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "oauth_authorization_url" TEXT;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "oauth_token_url" TEXT;
