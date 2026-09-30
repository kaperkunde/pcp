import { defineConfig } from "prisma/config"

import { databaseUrl } from "./lib/core/data-dir"

// The Prisma CLI (migrate dev, studio) reads this; the app itself opens the
// same file through lib/db.ts. Both derive the path from PCP_DATA_DIR, which
// defaults to ./data so nothing has to be configured.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl(),
  },
})
