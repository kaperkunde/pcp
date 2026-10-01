-- Memories read in every conversation.
--
-- memory.always: the owner marked the memory to be read at the start of every
-- conversation, so its text goes into the gateway's instructions. Off for
-- every existing memory.
--
-- A plain column addition, as in the migrations before this one: Prisma's
-- own diff would rebuild the table inside the boot migrator's transaction.

-- AlterTable
ALTER TABLE "memory" ADD COLUMN "always" BOOLEAN NOT NULL DEFAULT false;
