/**
 * Bounds on what an OpenAPI schema and an API's answers can make PCP do.
 * A schema is untrusted input: it comes from a URL or a file, and nothing
 * in it is allowed to cost more than these.
 */

/** Operations in one schema; more is refused rather than cut. */
export const MAX_OPERATIONS = 2000
/** One tool's argument schema, as JSON; a larger one skips the operation. */
export const MAX_TOOL_SCHEMA_CHARS = 32_000
/** JSON nesting while inlining references, per operation. */
export const REF_MAX_DEPTH = 64
/** Nodes visited while inlining references, per operation. */
export const REF_MAX_NODES = 20_000
export const MAX_TOOL_DESCRIPTION = 2000
export const MAX_YAML_ALIASES = 100

export const SPEC_FETCH_TIMEOUT_MS = 20_000
export const SPEC_MAX_REDIRECTS = 3

export const CALL_TIMEOUT_MS = 60_000
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024
export const MAX_RESPONSE_BYTES = 1024 * 1024
/** structuredContent is only added when it is at most this long as JSON. */
export const MAX_STRUCTURED_CHARS = 60_000
/** How much of an error answer's body is passed back. */
export const MAX_ERROR_EXCERPT = 2000
export const MAX_HEADER_VALUE = 8192

export const USER_AGENT = "pcp/0.1.0"
