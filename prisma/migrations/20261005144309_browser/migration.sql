-- The browser's sign-ins (lib/core/browser/): the vault's headless browser
-- keeps its cookies, local storage and IndexedDB here between runs, as one
-- blob encrypted under the vault's data key. One row per vault. The browser
-- itself is a server row of kind "browser", which needs no new column.
-- A new table, so nothing existing is rebuilt.

-- CreateTable
CREATE TABLE "browser_profile" (
    "vault_id" TEXT NOT NULL PRIMARY KEY,
    "ciphertext" BLOB NOT NULL,
    "sites" INTEGER NOT NULL DEFAULT 0,
    "cookies" INTEGER NOT NULL DEFAULT 0,
    "size" INTEGER NOT NULL DEFAULT 0,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "saved_at" DATETIME NOT NULL,
    CONSTRAINT "browser_profile_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
