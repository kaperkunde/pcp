-- Names sealed at rest (#96): a token's under the vault's key, a linked
-- file's under its link's key, and the asking token's name on an upload
-- page under the page's key (the page has no other). The plain columns
-- stay for rows from before.
ALTER TABLE "api_token" ADD COLUMN "sealed_name" BLOB;
ALTER TABLE "file_link" ADD COLUMN "sealed_name" BLOB;
ALTER TABLE "upload_link" ADD COLUMN "assistant" BLOB;
