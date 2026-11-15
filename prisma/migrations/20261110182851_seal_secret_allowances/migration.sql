-- A token's allowance to have a secret typed at a site keeps the site as a
-- keyed hash under the vault's key, the site sealed beside it (#96). Rows
-- from before keep it in plain text, with nothing sealed, until each
-- vault's rows are sealed.
ALTER TABLE "api_token_secret_allowance" ADD COLUMN "sealed" BLOB;
