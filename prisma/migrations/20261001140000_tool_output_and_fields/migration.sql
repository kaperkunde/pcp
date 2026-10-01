-- What a tool answers, and the parts of an answer an assistant asked for.
--
-- mcp_tool.output: an outline of what an API endpoint's tool answers when it
-- succeeds, read from its schema. Filled in when an endpoint's tools are
-- next read; null until then, and for MCP tools.
-- permission_request.fields: the paths call_tool's fields picked from the
-- answer of a call that waits for the owner, as JSON. Null for everything
-- else.
--
-- Plain column additions, like the migrations before: Prisma's own diff would
-- rebuild the tables.

-- AlterTable
ALTER TABLE "mcp_tool" ADD COLUMN "output" TEXT;

-- AlterTable
ALTER TABLE "permission_request" ADD COLUMN "fields" TEXT;
