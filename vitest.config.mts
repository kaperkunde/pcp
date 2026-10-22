import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: [
      "lib/**/*.test.ts",
      "scripts/**/*.test.ts",
      "desktop/*.test.mjs",
      "desktop/scripts/*.test.mjs",
    ],
    environment: "node",
    // Tests act far faster than a person: pacing (lib/core/pacing/) is off
    // except in the tests that turn it on to check it.
    env: { PCP_PACING: "off" },
  },
})
