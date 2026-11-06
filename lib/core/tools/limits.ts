/**
 * Bounds on checking a call's arguments against a schema are
 * @kaperkunde/mcp's (validate.ts): the schema comes from a server or an API
 * PCP does not control, and the arguments from an assistant, so every walk
 * is bounded. What PCP keeps of an upstream tool is bounded here.
 */
export {
  MAX_ARGUMENT_PROBLEMS,
  MAX_LISTED_KEYS,
  MAX_PATTERN_CHARS,
  MAX_PATTERN_SUBJECT_CHARS,
  MAX_REF_HOPS,
  MAX_VALIDATE_DEPTH,
  MAX_VALIDATE_STEPS,
} from "@kaperkunde/mcp"

/** Icons kept of the ones an MCP server gives a tool. */
export const MAX_TOOL_ICONS = 4
/** An icon's address (often a data: URI), in characters, still kept. */
export const MAX_ICON_SRC_CHARS = 16_000
/** An upstream tool's outputSchema, as JSON, still kept for describe. */
export const MAX_OUTPUT_SCHEMA_CHARS = 200_000
