-- Kept results can hold a file's bytes as well as a text (lib/core/tool-results.ts).
--
-- tool_result.kind: "text" for what every existing row is, "bytes" for a
-- file kept from an attachment or a binary field of an answer.
-- tool_result.name: the file's name, when it had one.
--
-- Plain column additions, as in 20261001170000_permission_decode: no table
-- is rebuilt.

-- AlterTable
ALTER TABLE "tool_result" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';

-- AlterTable
ALTER TABLE "tool_result" ADD COLUMN "name" TEXT;
