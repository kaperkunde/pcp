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
    // Cheaper key derivation for tests (see the file).
    setupFiles: ["./vitest.setup.ts"],
    // One file per processor, not one fewer (Vitest's default): the suites
    // that drive Chromium spend much of their time waiting on it, and the
    // whole run was about a sixth faster this way on four processors.
    maxWorkers: "100%",
    // Tests act far faster than a person: pacing (lib/core/pacing/) is off
    // except in the tests that turn it on to check it.
    env: { PCP_PACING: "off" },
  },
})
