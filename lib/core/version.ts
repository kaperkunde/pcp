import pkg from "@/package.json"

/**
 * PCP's version, as package.json has it. The release workflow writes the
 * patch there on every push to main, so a build always knows which release it
 * is. Anything that announces PCP (MCP server and client info)
 * uses this rather than a literal.
 */
export const PCP_VERSION: string = pkg.version

/** A commit as git names it, whole or shortened, in lower case; else null. */
export function buildCommit(value: string | undefined): string | null {
  const commit = value?.trim().toLowerCase() ?? ""

  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : null
}

/** A build's time as an ISO instant; null when there is none or it is no date. */
export function buildDate(value: string | undefined): string | null {
  const time = Date.parse(value?.trim() ?? "")

  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/**
 * The commit this build was made from, and when it was built: written into
 * the build by next.config.ts from PCP_COMMIT and PCP_BUILT_AT, which the
 * release and develop builds set (the Dockerfile's build arguments,
 * build-images.yml and build-desktop.yml). Null where nobody set them: a
 * checkout's own build, the dev server, a test. Read as written, never at
 * runtime (Next.js puts the values in place of `process.env.…` here).
 */
export const PCP_COMMIT: string | null = buildCommit(process.env.PCP_COMMIT)
export const PCP_BUILT_AT: string | null = buildDate(process.env.PCP_BUILT_AT)
