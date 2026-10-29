# Breaking changes

What changed in how an assistant or an MCP client talks to PCP, newest
first, and what to do about it. An old argument name keeps working for one
release, with a note in front of the answer ("addPatches was renamed to
add_patches; use add_patches."); after that it is refused like any other
unknown key.

## PCP's own tools on one interface

### Removed tools

| Removed         | Use instead                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `search_tools`  | `search`, with `kind: "tool"` for tools only and `server` for one server's.                    |
| `describe_tool` | `describe`, with `server` and `tool` as before, or `ref` (`server/tool`) as `search` gives it. |

### Renamed arguments (old names accepted for one release)

Every argument of PCP's own tools is snake_case now.

| Tool              | Old name               | New name                |
| ----------------- | ---------------------- | ----------------------- |
| `update_endpoint` | `addPatches`           | `add_patches`           |
| `update_endpoint` | `refreshSpec`          | `refresh_spec`          |
| `update_endpoint` | `baseUrl`              | `base_url`              |
| `update_endpoint` | `readOnly`             | `read_only`             |
| `update_endpoint` | `toolDescriptions`     | `tool_descriptions`     |
| `get_endpoint`    | `includeSpec`          | `include_spec`          |
| `get_endpoint`    | `includePatches`       | `include_patches`       |
| `get_endpoint`    | `specPointer`          | `spec_pointer`          |
| `get_endpoint`    | `includeProblems`      | `include_problems`      |
| `create_wrapper`  | `callLevels`           | `call_levels`           |
| `create_wrapper`  | `tools[].inputSchema`  | `tools[].input_schema`  |
| `create_wrapper`  | `tools[].outputSchema` | `tools[].output_schema` |
| `update_wrapper`  | `callLevels`           | `call_levels`           |
| `update_wrapper`  | `removeTools`          | `remove_tools`          |
| `update_wrapper`  | `tools[].inputSchema`  | `tools[].input_schema`  |
| `update_wrapper`  | `tools[].outputSchema` | `tools[].output_schema` |

Passing an old name and its new one together is refused.

### Answers that read differently

- `get_wrapper` answers in the names `update_wrapper` takes: `call_levels`,
  and each tool's `input_schema` and `output_schema`.
- `get_endpoint`'s `changes` names the fields as `update_endpoint` takes
  them (`tool_descriptions`, `refresh_spec`, `base_url`, `read_only`).
- A call that waits for the owner carries `structuredContent`
  `{"kind": "needs_owner", "reason": "permission" | "connect", "url",
"label", …}`, on every tool. A permission request names its id in
  `request`; a server to connect has `connect` (its links) and, from
  `check_server`, `server`. This replaces `{"kind": "connect", …}`.
- `check_server`, `check_permission`, `register_server`,
  `propose_tool_access`, `update_endpoint`, `get_endpoint`, `list_secrets`,
  the wrapper tools, `share_result` and `receive_file` declare an
  `outputSchema`, and their answers carry matching `structuredContent`.
  `check_permission` answers `{"kind": "done", "request", "status",
"server"?}` once a request is settled and `{"kind": "requests",
"requests": […]}` without an id; `check_server` answers `{"kind": "done",
"server"}` once connected.
- A refusal PCP writes carries its code in `_meta["gg.pcp/error"]`
  (`{"code": "not_found" | "forbidden" | "invalid_arguments" |
"rate_limited" | "internal" | …, "hint"?}`).

### Stricter arguments

- PCP's own tools publish closed schemas (`additionalProperties: false`)
  and refuse a key they do not take, naming it and the ones they do; before,
  it was dropped without a word. Arguments that do not fit are a tool
  error (`isError`, code `invalid_arguments`) in PCP's words, not the SDK's.
- `call_tool` and `call_read_only_tool` check the arguments against the
  tool's inputSchema strictly before anything runs or the owner is asked:
  lengths, patterns, formats (date, date-time, email, uri, uuid, ipv4,
  ipv6), bounds, `prefixItems`, a `oneOf` that matches exactly one option,
  and references inside the schema. A reference to another document is
  refused. A kept result's handle (`{"$result": id}`) passes only where a
  string may go.
- `run_code`'s `pcp.call` checks its arguments the same way, before it
  runs or asks; a call that does not fit throws an Error naming every
  problem.

### Call handles

A `call_handle` is tied to the hash of the tool's inputSchema as stored.
PCP's own tools take none, so nothing here makes one stale; a change to
how PCP converts a server's or an API's schema does, once: the call answers
"The tool changed since you described it" with a fresh handle, and the
assistant simply calls again with it (or describes the tool again).

### The /mcp endpoint

- Errors PCP answers before the MCP server does (no token, too many
  requests, a batch) use JSON-RPC's Invalid Request, `-32600`, instead of
  `-32000`, which MCP leaves to older servers.
- CORS no longer allows `Mcp-Session-Id` and `Last-Event-ID` or exposes
  `Mcp-Session-Id`: `/mcp` is stateless in both protocol versions, with no
  session and no stream to resume.
