-- Secrets typed in the browser (lib/core/browser-secrets.ts): the origins
-- where a secret may be typed into a page, and the uses of one the owner
-- allowed a token for an hour, once or always. Neither holds a value.
--
-- New tables only: nothing that exists is rebuilt.

-- CreateTable
CREATE TABLE "api_token_secret_allowance" (
    "token_id" TEXT NOT NULL,
    "secret_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "until" DATETIME,
    "once" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("token_id", "secret_id", "origin"),
    CONSTRAINT "api_token_secret_allowance_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_token_secret_allowance_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secret" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "secret_browser_origin" (
    "secret_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("secret_id", "origin"),
    CONSTRAINT "secret_browser_origin_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secret" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "api_token_secret_allowance_until_idx" ON "api_token_secret_allowance"("until");
