import pkg from "@/package.json"

/**
 * PCP's version, as package.json has it. The release workflow writes the
 * patch there on every push to main, so a build always knows which release it
 * is. Anything that announces PCP (MCP server and client info, the panel)
 * uses this rather than a literal.
 */
export const PCP_VERSION: string = pkg.version
