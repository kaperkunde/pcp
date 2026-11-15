-- A tool's title and description, its schemas, call plan and outline, and
-- the owner's wording are sealed under the vault's key (#96). The plain
-- columns stay for rows from before, until each vault's rows are sealed;
-- a sealed row holds blanks in them. The tool's name stays plain.
ALTER TABLE "mcp_tool" ADD COLUMN "about" BLOB;
ALTER TABLE "mcp_tool" ADD COLUMN "schema" BLOB;
ALTER TABLE "mcp_tool" ADD COLUMN "override" BLOB;
