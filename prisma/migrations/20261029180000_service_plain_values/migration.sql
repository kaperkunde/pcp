-- A service's plain variables (lib/core/services/definition.ts `plain`):
-- what the owner typed for them per instance, a VPN provider's name or a
-- country, never a secret.
--
-- A plain addition: one column with a default, no rebuild.

-- AlterTable
ALTER TABLE "service_spec" ADD COLUMN "plain_values" TEXT NOT NULL DEFAULT '{}';
