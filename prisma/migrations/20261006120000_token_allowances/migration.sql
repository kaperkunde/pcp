-- "Allow for" on a permission request: a tool or a site one token may use
-- without asking the owner until a time (lib/core/allowances.ts). New
-- tables only; nothing existing is rebuilt.

-- CreateTable
CREATE TABLE "api_token_tool_allowance" (
    "token_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "until" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("token_id", "server_id", "tool_name"),
    CONSTRAINT "api_token_tool_allowance_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_token_tool_allowance_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_token_site_allowance" (
    "token_id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "until" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("token_id", "host"),
    CONSTRAINT "api_token_site_allowance_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "api_token_tool_allowance_until_idx" ON "api_token_tool_allowance"("until");

-- CreateIndex
CREATE INDEX "api_token_site_allowance_until_idx" ON "api_token_site_allowance"("until");
