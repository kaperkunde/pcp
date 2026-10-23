-- api_token.memory_migration: while on (and keep_memories is), the gateway's
-- instructions ask the assistant to offer to move the memories and skills its
-- client keeps elsewhere into PCP; it turns this off when done, and only the
-- owner turns it on. On for every existing token too, so the assistants that
-- already keep memories make the offer once. A plain column addition: a
-- table rebuild would drop api_token inside the boot migrator's transaction
-- and cascade to everything that references it.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "memory_migration" BOOLEAN NOT NULL DEFAULT true;
