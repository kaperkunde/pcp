-- Where a JMAP account uploads the attachments it sends.
--
-- mcp_server.mail_upload_url: the session document's upload URL template,
-- taken only on the session URL's origin, like mail_download_url. Null until
-- the session is read again, which happens on the next call.
--
-- A plain column addition, as in 20261001170000_permission_decode.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_upload_url" TEXT;
