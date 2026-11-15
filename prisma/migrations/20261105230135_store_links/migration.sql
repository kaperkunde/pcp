-- Links to a store's files (share_file) and uploads into a store. Added in
-- place: a table rebuild would cascade.
ALTER TABLE "upload_link" ADD COLUMN "destination" BLOB;
ALTER TABLE "file_link" ADD COLUMN "store_id" TEXT;
ALTER TABLE "file_link" ADD COLUMN "store_path" BLOB;
ALTER TABLE "file_link" ADD COLUMN "delivered_at" DATETIME;
ALTER TABLE "file_link" ADD COLUMN "claimed_at" DATETIME;
ALTER TABLE "file_link" ADD COLUMN "object_id" TEXT;
ALTER TABLE "file_link" ADD COLUMN "file_key" BLOB;
ALTER TABLE "file_link" ADD COLUMN "served_bytes" REAL NOT NULL DEFAULT 0;
