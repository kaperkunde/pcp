-- AlterTable
ALTER TABLE "secret" ADD COLUMN "scope_anywhere" BOOLEAN DEFAULT false;

-- Every secret from before has no scope yet: null until the first request
-- that holds the vault's key gives it its uses as its scope, or anywhere
-- when nothing uses it (lib/core/secret-scope.ts ensureSecretScopes). Its
-- uses are in sealed definitions, which this file cannot read; until then a
-- null scope reads as anywhere, which is what PCP did before.
UPDATE "secret" SET "scope_anywhere" = NULL;

-- CreateTable
CREATE TABLE "secret_scope" (
    "secret_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("secret_id", "server_id"),
    CONSTRAINT "secret_scope_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secret" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "secret_scope_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "secret_scope_server_id_idx" ON "secret_scope"("server_id");
