-- How PCP reaches a service (lib/core/services/): "tunnel", through the SSH
-- connection to the address its ports are bound to on the SSH server, or
-- "direct", from PCP's machine. Every service there was is "direct" and
-- keeps working as it did; launching, updating or making one again writes
-- "tunnel".
--
-- What the owner last asked of it, "running" or "stopped": a call that
-- finds it down starts it again only while it is "running".
--
-- Plain additions: columns with defaults, no rebuild.

-- AlterTable
ALTER TABLE "service_spec" ADD COLUMN "reach" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "service_spec" ADD COLUMN "intended_state" TEXT NOT NULL DEFAULT 'running';
