-- What servers are built from is sealed under the vault's key (#96): an
-- endpoint's schema text and edits, a wrapper's and a service's definition.
-- Their hash becomes a keyed hash as each row is sealed. The plain columns
-- stay for rows from before, until each vault's rows are sealed.
ALTER TABLE "openapi_spec" ADD COLUMN "sealed_text" BLOB;
ALTER TABLE "openapi_spec" ADD COLUMN "sealed_patches" BLOB;
ALTER TABLE "wrapper_spec" ADD COLUMN "sealed_definition" BLOB;
ALTER TABLE "service_spec" ADD COLUMN "sealed_definition" BLOB;
