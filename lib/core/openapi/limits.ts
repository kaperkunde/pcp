/**
 * Bounds on what an OpenAPI schema and an API's answers can make PCP do.
 * A schema is untrusted input: it comes from a URL or a file, and nothing
 * in it is allowed to cost more than these.
 */

import { PCP_VERSION } from "../version"

/** Operations in one schema; more is refused rather than cut. */
export const MAX_OPERATIONS = 2000
/** One tool's argument schema, as JSON; a larger one skips the operation. */
export const MAX_TOOL_SCHEMA_CHARS = 32_000
/** JSON nesting while inlining references, per operation. */
export const REF_MAX_DEPTH = 64
/** Nodes visited while inlining references, per operation. */
export const REF_MAX_NODES = 20_000
/**
 * Nodes visited while inlining references, across the whole schema. Each
 * operation has its own budget, but 2000 operations at the full budget would
 * hold the server for seconds; past this, the rest are skipped.
 */
export const MAX_TOTAL_REF_NODES = 1_000_000
/**
 * String characters copied while inlining references, per operation: keys
 * and text in schemas, examples, descriptions. Nodes are counted separately;
 * one 4 MB example is one node.
 */
export const REF_MAX_CHARS = 64_000
/**
 * Nodes in the parsed YAML once every alias is counted as the copy it will
 * be. A flat array aliased 100 times passes the YAML library's own alias
 * check (it counts aliases inside a value, not its size) and is 100 times
 * the file.
 */
export const MAX_SPEC_NODES = 2_000_000
/** Lengths past which a name or address in a schema is not read at all. */
export const MAX_PATH_LENGTH = 2048
export const MAX_NAME_LENGTH = 256
export const MAX_SERVER_URL_LENGTH = 2048
export const MAX_PARAMETERS = 200
/** Scopes PCP asks for from one schema's OAuth flow. */
export const MAX_OAUTH_SCOPES = 100
export const MAX_TOOL_DESCRIPTION = 2000
/** The outline of what a tool answers (outline.ts), as text. */
export const MAX_OUTLINE_CHARS = 2000
/** Properties of one object an outline names before "… N more". */
export const MAX_OUTLINE_PROPERTIES = 40
/** Likely mistakes in a schema listed at once (lint.ts). */
export const MAX_SCHEMA_PROBLEMS = 50
/** Schema nodes visited while outlining one answer. */
export const OUTLINE_MAX_NODES = 2000
/**
 * Everything one endpoint's tools may add up to once stored (schemas,
 * descriptions, call plans). Every gateway request reads the catalogue, and
 * a schema within every other limit can still come to tens of megabytes.
 */
export const MAX_TOTAL_TOOL_CHARS = 4_000_000
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

export const USER_AGENT = `pcp/${PCP_VERSION}`

/** Edits (JSON Patch operations) kept on one endpoint. */
export const MAX_PATCH_OPERATIONS = 1000
/** All of one endpoint's edits, as JSON. */
export const MAX_PATCH_CHARS = 1_000_000
/** A JSON Pointer in an edit, or one asked for by get_endpoint. */
export const MAX_POINTER_LENGTH = 2048
