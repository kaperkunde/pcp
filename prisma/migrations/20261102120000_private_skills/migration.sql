-- Skills an assistant keeps for its own token (lib/core/skills.ts). Added
-- columns only: a table rebuild would drop the skill table, and with it every
-- row that points at a skill.
ALTER TABLE "skill" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE "skill" ADD COLUMN "token_id" TEXT REFERENCES "api_token" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "skill_token_id_idx" ON "skill"("token_id");
