import { existsSync } from "node:fs"

import { getHostSetting } from "../host-settings"

/**
 * Where the Chromium the browser runs comes from, in order: the
 * environment (PCP_BROWSER_EXECUTABLE, for a system Chromium), the path
 * the owner's install saved in the host settings, Playwright's own
 * variable, then where Playwright installs it. Never vault data: the
 * browser belongs to the machine.
 */

export const BROWSER_EXECUTABLE_KEY = "browser.executable"

export async function chromiumExecutable(): Promise<string | null> {
  return firstThere([
    process.env.PCP_BROWSER_EXECUTABLE,
    await getHostSetting(BROWSER_EXECUTABLE_KEY),
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    await playwrightDefault(),
  ])
}

/** The same without the host setting: for tests, which have no database yet. */
export async function chromiumFromEnvironment(): Promise<string | null> {
  return firstThere([
    process.env.PCP_BROWSER_EXECUTABLE,
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
    const { chromium } = await import("playwright-core")
    return chromium.executablePath()
  } catch {
    return null
  }
}
