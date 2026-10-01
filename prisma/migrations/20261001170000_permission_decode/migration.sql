-- Where a waiting call's answer is decoded from base64.
--
-- permission_request.decode: the paths call_tool's decode named for a call
-- that waits for the owner, as JSON, so the answer they allow is decoded the
-- way the assistant asked. Null for everything else.
--
-- A plain column addition, as in 20261001140000_tool_output_and_fields.

-- AlterTable
ALTER TABLE "permission_request" ADD COLUMN "decode" TEXT;
