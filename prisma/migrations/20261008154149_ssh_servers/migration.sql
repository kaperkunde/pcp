-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN "ssh_certificate" TEXT;
ALTER TABLE "mcp_server" ADD COLUMN "ssh_host_cas" TEXT;
ALTER TABLE "mcp_server" ADD COLUMN "ssh_public_key" TEXT;
