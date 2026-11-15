-- The browser's user agent on a session was written and never read
-- (#96): dropped in place, not by a table rebuild.
ALTER TABLE "session" DROP COLUMN "user_agent";
