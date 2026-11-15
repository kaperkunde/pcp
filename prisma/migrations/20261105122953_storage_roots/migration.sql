-- CreateTable
CREATE TABLE "storage_root" (
    "server_id" TEXT NOT NULL PRIMARY KEY,
    "host_id" TEXT,
    "path" TEXT NOT NULL,
    "write_as" TEXT NOT NULL DEFAULT '',
    "umask" INTEGER NOT NULL DEFAULT 2,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "storage_root_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "storage_root_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "mcp_server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "storage_root_host_id_idx" ON "storage_root"("host_id");
