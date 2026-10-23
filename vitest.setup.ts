import { vi } from "vitest"

// The owner's password and an export's password go through scrypt with
// 64 MiB of memory (lib/core/crypto.ts), a tenth of a second or more each:
// slow on purpose, and across the hundreds of tests that set up a vault, much
// of the suite's time. Tests derive with the smallest cost an export file may
// still ask for (backup-format.ts), so every path stays the one PCP runs:
// the parameters are stored with each grant and read back from it.
vi.mock("@/lib/core/crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("@/lib/core/crypto")>()

  return {
    ...crypto,
    newScryptParams: () => ({ ...crypto.newScryptParams(), N: 1 << 14 }),
  }
})
