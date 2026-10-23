-- Whether PCP files a copy of what an IMAP account sends in Sent, and what
-- it learned about whether the mail server files one itself
-- (lib/core/mail/imap.ts). Plain column additions: Prisma's own diff would
-- rebuild mcp_server, and a DROP inside the boot migrator's transaction
-- cascades to everything that references it.

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "mail_save_sent" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "mcp_server" ADD COLUMN "mail_server_files_sent" BOOLEAN;
