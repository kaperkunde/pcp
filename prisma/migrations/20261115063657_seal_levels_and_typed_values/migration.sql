-- The last descriptive values still in plain text are sealed under the
-- vault's key (#96): the tool names on the owner's levels, allowances,
-- tiers and requests (the tool_name column holds a keyed hash once sealed,
-- the name in `sealed`), a service's own values (sealed_own), and a further
-- header's name and template (sealed). Rows from before are converted by the
-- first request that holds the key. Only columns are added; no index or key
-- changes, so no table is rebuilt.
-- AlterTable
ALTER TABLE "api_token_tool_access" ADD COLUMN "sealed" BLOB;

-- AlterTable
ALTER TABLE "api_token_tool_allowance" ADD COLUMN "sealed" BLOB;

-- AlterTable
ALTER TABLE "permission_request" ADD COLUMN "tool_sealed" BLOB;

-- AlterTable
ALTER TABLE "server_auth_header" ADD COLUMN "sealed" BLOB;

-- AlterTable
ALTER TABLE "service_spec" ADD COLUMN "sealed_own" BLOB;

-- AlterTable
ALTER TABLE "tool_tier" ADD COLUMN "sealed" BLOB;

-- AlterTable
ALTER TABLE "vault_tool_access" ADD COLUMN "sealed" BLOB;
