-- A secret's sign-in (lib/core/secrets.ts): the owner's login name and note,
-- encrypted, and the TOTP secret that goes with it. Added columns only: a
-- table rebuild would drop the secret table, and with it every row that
-- points at a secret.
ALTER TABLE "secret" ADD COLUMN "login_name" BLOB;
ALTER TABLE "secret" ADD COLUMN "note" BLOB;
ALTER TABLE "secret" ADD COLUMN "totp_companion_id" TEXT REFERENCES "secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
