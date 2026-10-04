-- Mail accounts: servers of kind "jmap" and "imap" (lib/core/mail/).
--
-- mcp_server.auth_username: the user name for "basic" authentication (a JMAP
-- server's Basic authentication, an IMAP and SMTP login).
-- mcp_server.mail_api_url, mail_download_url, mail_account_id,
-- mail_submission: what a JMAP session document said when it was last read.
-- mcp_server.smtp_url: where an IMAP account sends mail; null when it cannot.
-- mcp_server.mail_from: the From address when sending.
-- Empty or off for every existing server.
--
-- Plain column additions, as in the endpoint migrations: Prisma's own diff
-- would rebuild the table, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "auth_username" TEXT;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_api_url" TEXT;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_download_url" TEXT;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_account_id" TEXT;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_submission" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "smtp_url" TEXT;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_from" TEXT;
