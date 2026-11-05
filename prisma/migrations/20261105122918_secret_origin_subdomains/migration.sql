-- A secret's site can be "this domain and its subdomains". An added column,
-- not a table rebuild: a rebuild's drop would cascade.
ALTER TABLE "secret_browser_origin" ADD COLUMN "include_subdomains" BOOLEAN NOT NULL DEFAULT false;
