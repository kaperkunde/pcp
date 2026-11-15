-- A server's own call limits (lib/core/gate/, #143): calls at once, pause,
-- calls a minute, time per call, bytes a day and cool-downs, as the owner
-- set them, sealed under the vault's key as "mcp_server:<id>:limits". Null
-- follows its kind's defaults.
ALTER TABLE "mcp_server" ADD COLUMN "limits" BLOB;
