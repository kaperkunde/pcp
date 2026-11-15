-- A kept file's name is sealed under the vault's key (#96). The plain
-- column stays for rows from before, until each vault's rows are sealed
-- (or the row's day is up).
ALTER TABLE "tool_result" ADD COLUMN "sealed_name" BLOB;
