-- Which parts of a waiting call's answer are kept as results.
--
-- permission_request.keep: the paths call_tool's keep named for a call that
-- waits for the owner, as JSON, so the answer they allow hands back the same
-- handles the assistant asked for. Null for everything else.
--
-- A plain column addition, as in 20261001170000_permission_decode.

-- AlterTable
ALTER TABLE "permission_request" ADD COLUMN "keep" TEXT;
