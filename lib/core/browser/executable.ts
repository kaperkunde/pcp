import { existsSync } from "node:fs"

import { dataDir } from "../data-dir"
import { installedChromium } from "./install"

/**
 * Where the Chromium the browser runs comes from, in order: the
 * environment (PCP_BROWSER_EXECUTABLE, for a system Chromium), the one the
 * owner installed from the Browser page (install.ts), Playwright's own
 * variable, then where Playwright installs it. Never vault data: the
 * browser belongs to the machine.
 */
export async function chromiumExecutable(): Promise<string | null> {
  return firstThere([
    process.env.PCP_BROWSER_EXECUTABLE,
    await installedChromium(dataDir()),
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    await playwrightDefault(),
  ])
}

function firstThere(
  candidates: Array<string | null | undefined>,
): string | null {
  return (
    candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
  )
}

async function playwrightDefault(): Promise<string | null> {
  try {
    const { chromium } = await import("patchright-core")
    return chromium.executablePath()
  } catch {
    return null
  }
}
