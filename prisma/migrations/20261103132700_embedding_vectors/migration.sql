-- CreateTable
CREATE TABLE "embedding_vector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "ciphertext" BLOB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "embedding_vector_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "embedding_vector_used_at_idx" ON "embedding_vector"("used_at");

-- CreateIndex
CREATE UNIQUE INDEX "embedding_vector_vault_id_hash_key" ON "embedding_vector"("vault_id", "hash");
