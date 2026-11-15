-- CreateTable
CREATE TABLE "storage_entry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "parent_id" TEXT NOT NULL DEFAULT '',
    "name_key" TEXT NOT NULL,
    "folder" BOOLEAN NOT NULL DEFAULT false,
    "object_id" TEXT NOT NULL DEFAULT '',
    "file_key" BLOB,
    "meta" BLOB NOT NULL,
    "stored_bytes" REAL NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "storage_entry_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "storage_pending" (
    "object_id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "storage_pending_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Storage roots become stores: what was there stays a plain folder over
-- SFTP. Added in place: a table rebuild would cascade to its server rows.
ALTER TABLE "storage_root" ADD COLUMN "backend" TEXT NOT NULL DEFAULT 'sftp';
ALTER TABLE "storage_root" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'plain';
ALTER TABLE "storage_root" ADD COLUMN "store_key" BLOB;
ALTER TABLE "storage_root" ADD COLUMN "converting" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "storage_entry_server_id_parent_id_idx" ON "storage_entry"("server_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_entry_server_id_parent_id_name_key_key" ON "storage_entry"("server_id", "parent_id", "name_key");

-- CreateIndex
CREATE INDEX "storage_pending_server_id_created_at_idx" ON "storage_pending"("server_id", "created_at");
