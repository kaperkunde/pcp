-- Sharing per item in linked repositories (lib/core/repos/): whether a
-- repository is private on GitHub, stored when PCP asks GitHub (null until
-- then), and the items the owner keeps out of a repository on purpose, by
-- skill or by server definition.
--
-- Plain additions: a new nullable column and a new table, no rebuild.

-- AlterTable
ALTER TABLE "repo" ADD COLUMN "private" BOOLEAN;

-- CreateTable
CREATE TABLE "repo_exclusion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo_id" TEXT NOT NULL,
    "skill_id" TEXT,
    "definition_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repo_exclusion_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_exclusion_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_exclusion_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "server_definition" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "repo_exclusion_repo_id_skill_id_key" ON "repo_exclusion"("repo_id", "skill_id");

-- CreateIndex
CREATE UNIQUE INDEX "repo_exclusion_repo_id_definition_id_key" ON "repo_exclusion"("repo_id", "definition_id");
