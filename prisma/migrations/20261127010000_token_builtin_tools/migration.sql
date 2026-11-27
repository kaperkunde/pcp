-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "builtin_tools" TEXT NOT NULL DEFAULT '[]';
