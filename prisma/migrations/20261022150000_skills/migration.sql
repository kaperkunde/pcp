-- skills: procedures the owner approved, for assistants to follow when a
-- task matches (lib/core/skills.ts). The name, description, version, body,
-- tools and files are one ciphertext under the vault's key ("skill:<id>").
-- api_token_skill lists the skills a token sees once the owner chose some;
-- all_skills (on for every existing token) is every skill.
--
-- A plain column addition on api_token: Prisma's own diff would rebuild it,
-- and a DROP inside the boot migrator's transaction cascades to everything
-- that references it.

-- CreateTable
CREATE TABLE "skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vault_id" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'owner',
    "ciphertext" BLOB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "skill_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "vault" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_token_skill" (
    "token_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,

    PRIMARY KEY ("token_id", "skill_id"),
    CONSTRAINT "api_token_skill_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_token_skill_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "all_skills" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "skill_vault_id_idx" ON "skill"("vault_id");

-- CreateIndex
CREATE INDEX "api_token_skill_skill_id_idx" ON "api_token_skill"("skill_id");
