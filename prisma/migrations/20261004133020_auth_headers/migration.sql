-- Further secret headers for header authentication.
--
-- server_auth_header: headers sent with the one on the server row, each
-- carrying a secret, for an API that takes its credential in several parts
-- (a key and a secret key, say). None for every existing server.

-- CreateTable
CREATE TABLE "server_auth_header" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "server_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "header_name" TEXT NOT NULL,
    "value_template" TEXT NOT NULL,
    "secret_id" TEXT,
    CONSTRAINT "server_auth_header_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "server_auth_header_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "server_auth_header_secret_id_idx" ON "server_auth_header"("secret_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_auth_header_server_id_position_key" ON "server_auth_header"("server_id", "position");
