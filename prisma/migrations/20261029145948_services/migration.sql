-- Services (lib/core/services/): a container PCP runs with the owner's Docker or
-- Podman on one of their SSH servers. Its server row is of kind "service";
-- this table holds what it runs and where.
--
-- A plain addition: a new table, no rebuild.

-- CreateTable
CREATE TABLE "service_spec" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "definition" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "host_id" TEXT,
    "engine" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL DEFAULT '',
    "container_name" TEXT NOT NULL,
    "publish" TEXT NOT NULL DEFAULT '{}',
    "env" TEXT NOT NULL DEFAULT '{}',
    "registered_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "service_spec_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "service_spec_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "mcp_server" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "service_spec_registered_id_fkey" FOREIGN KEY ("registered_id") REFERENCES "mcp_server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "service_spec_registered_id_key" ON "service_spec"("registered_id");

-- CreateIndex
CREATE INDEX "service_spec_host_id_idx" ON "service_spec"("host_id");
