-- Which PCP built an API endpoint's tools.
--
-- openapi_spec.built_with: the PCP_VERSION whose generator turned the kept
-- schema into the endpoint's tools. When PCP starts under another version it
-- rebuilds those tools from the kept copy, so what a newer generator adds (an
-- answer's outline, a header PCP sends itself) reaches endpoints that were
-- added before it, without a download or the owner. Null until the tools are
-- next built, which the first boot with this column does.
--
-- A plain column addition, as in 20261001150000_endpoint_oauth.

-- AlterTable
ALTER TABLE "openapi_spec" ADD COLUMN "built_with" TEXT;
