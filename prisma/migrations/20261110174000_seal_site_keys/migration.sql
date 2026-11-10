-- Sites are kept as keyed hashes under the vault's key, the site itself
-- sealed beside it (#96): a secret's sites, a token's site allowances and
-- web fetch's site and script lines. Rows from before keep the site in
-- plain text, with nothing sealed, until each vault's rows are sealed.
ALTER TABLE "secret_browser_origin" ADD COLUMN "sealed" BLOB;
ALTER TABLE "api_token_site_allowance" ADD COLUMN "sealed" BLOB;
ALTER TABLE "web_fetch_rule" ADD COLUMN "sealed" BLOB;
