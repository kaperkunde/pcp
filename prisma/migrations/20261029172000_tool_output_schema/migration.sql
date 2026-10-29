-- What a tool answers, as the JSON Schema its server, family or wrapper
-- declares (outputSchema), and the icons an MCP server gave it. Plain
-- additions: nullable columns, no rebuild.

-- AlterTable
ALTER TABLE "mcp_tool" ADD COLUMN "output_schema" TEXT;

-- AlterTable
ALTER TABLE "mcp_tool" ADD COLUMN "icons" TEXT;
