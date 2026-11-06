/**
 * The one interface every tool PCP exposes is written to is
 * @kaperkunde/mcp's defineTool: PCP's own tools at /mcp (gateway.ts), and
 * through defineInnerTool (family.ts) every family behind call_tool.
 *
 *   defineTool({ name, title, description, input, output?, annotations,
 *                aliases?, log?, quiet?, invalidHint?, run })
 *
 * - `input`: a zod object, published as JSON Schema 2020-12, every object
 *   closed and every property described (refused when the schema is first
 *   made). Arguments are checked against that same JSON Schema by
 *   validate.ts inside the call (serve.ts), so a refusal reaches the request
 *   log; an unknown key is an error that names it and the keys the tool
 *   takes, never dropped.
 * - `output`: declared when every successful answer is one JSON shape: a
 *   tool that can wait for the owner lists NEEDS_OWNER (outcome.ts) among
 *   its shapes. A tool that answers in prose, or passes on another tool's
 *   answer (call_tool, run_code), has no output schema.
 * - `annotations`: all four hints, always. A proposal that only asks the
 *   owner (it writes nothing until they agree, and each call is a new
 *   request) is not destructive and not idempotent.
 * - `aliases`: old argument names, accepted for one release, with a note
 *   in the answer (docs/breaking-changes.md lists them).
 * - `log`: the server and upstream tool for the request log, from the
 *   arguments as sent; never anything else of them. `quiet`: its refusals
 *   quote what was sent (a memory's path), so the log keeps only that it
 *   failed.
 * - `run(args, ctx)`: the outcome (outcome.ts). A thrown PcpError is a
 *   toolError with its code; anything else thrown is PCP's fault, logged on
 *   the server.
 */
export {
  applyAliases,
  checkToolName,
  defineTool,
  isToolName,
  publishedSchema,
  toolJsonSchema,
  toolSchemas,
  undescribedProperties,
  type AliasResult,
  type LogNames,
  type Tool,
  type ToolAnnotations,
  type ToolContext,
  type ToolSpec,
} from "@kaperkunde/mcp"
