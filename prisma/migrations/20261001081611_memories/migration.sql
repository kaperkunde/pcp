-- Memories an assistant keeps for the owner through the gateway.
--
-- api_token.keep_memories: whether a token may use the memory tool. Off for
-- every existing token.
-- memory: one note, its path and text encrypted under the vault's data key.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild api_token, and a DROP inside the boot migrator's
-- transaction cascades to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "keep_memories" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "memory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "token_id" TEXT,
    "author" TEXT NOT NULL DEFAULT 'assistant',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "ciphertext" BLOB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "memory_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memory_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "memory_vault_id_visibility_idx" ON "memory"("vault_id", "visibility");

-- CreateIndex
CREATE INDEX "memory_token_id_idx" ON "memory"("token_id");
