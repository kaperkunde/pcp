# Breaking changes

What changed in how an assistant or an MCP client talks to PCP, newest
first, and what to do about it. An old argument name keeps working for one
release, with a note in front of the answer ("addPatches was renamed to
add_patches; use add_patches."); after that it is refused like any other
unknown key.

## The same Write or Destructive call twice is answered, not run

No tool or argument was renamed. A Write or Destructive call made again by
the same token with the same server, tool and arguments within 30 minutes
(the owner can change that per tool, or turn it off) is no longer run a
second time: `call_tool_write` and `call_tool_destructive` answer a tool
error with code `duplicate_call` saying how the first call went, and a
program's `pcp.call` (run_code, a wrapper) throws an Error with that code.
To make it again on purpose, pass `rerun: true` with a `reason` on
`call_tool_write`/`call_tool_destructive`, or `{ rerun: true, reason }` in
`pcp.call`'s options (`--rerun REASON` for the sandbox's `pcp call`,
`rerun=True, reason=…` in Python). A program run again after it stopped
for the owner meets `duplicate_call` on the calls that already ran: leave
them out of the program or catch the error. Read tools, the browser, SSH's
`run_command`, stores and calls the owner allowed on PCP's page are not
guarded.

## Services: an MCP server a service registers can send a secret header

No tool or argument was renamed. A service's definition (`register_server`
with kind `service`) takes `auth` on `registers` of kind `mcp` as kind
`openapi` has: `{"env", "header", "template"}`, the variable whose secret
the MCP server sends, in that header, the value written with `{{secret}}`.
The variable is named in `env_secrets` like any other, and the request
shows the header. In a linked repository, a service's document that has
one is written as `pcp_format: 4`; a PCP before this one refuses that
document as written by a newer PCP (every other document is written as
before). A running service's MCP server takes a definition's new `auth`
when the service is updated or made again.

## Browser: time limits, a busy tab, and tabs that close themselves

- `tabs` open, `navigate` and `snapshot` now wait 10 seconds in all unless
  `timeout_ms` says otherwise (longer while a site's check is up); every
  browser tool but `hand_over` and `request_secret` takes `timeout_ms`
  (1,000 to 120,000). Past it the call answers with a tool error, code
  `timeout`, naming the step it was at. A page that takes longer to load
  needs a `timeout_ms`.
- A call that would wait behind more than its tab takes is refused at once
  with code `browser_busy` and `retryAfterMs` in `_meta["gg.pcp/error"]`.
- A tab nobody used for 30 minutes, or whose run (run_code's or a wrapper's)
  has ended and that nothing used for two minutes since, is closed at the
  next browser call. A flow that leaves a tab for the assistant to go on
  with should have the assistant use it soon: a call outside the run keeps
  it.
- Every `tabs` answer says how many tabs are open ("5 of 8 tabs open in the
  browser, 2 of them this token's"); `Opened a new tab: <id>` is now
  followed by that in brackets, then the full stop.

## Services: published on the SSH server's loopback, started on demand

No tool or argument was renamed. `register_server` with kind `service`
now publishes the ports on the SSH server's own `127.0.0.1` when
`publish_address` is left out (it was `0.0.0.0`, every address): PCP
reaches the service through the SSH connection, so nothing else on that
network does. Name `0.0.0.0` or one of the SSH server's addresses when its
network should reach the service too; the owner sees it on the request.

A call to an API endpoint or MCP server a service serves, which finds the
service's container stopped while the owner left it running, starts it,
sends the call again and answers with one more text block after the
answer: "PCP started the service …". The first block is the answer as
before.

## Front-loaded descriptions, and lines search and describe add once

No tool or argument was renamed. Every PCP tool's description now opens
with a verb and what it acts on (`read_memory`: "START HERE: owner's rules

- memories."; `memory`: "Save memories in PCP, not your own memory: …"), so
  a client that compares descriptions sees them all change once.

`search` and `describe` answers can carry one or two text blocks after the
answer itself, once a session: a reminder to call `read_memory` with
`every` while it has not run, and, for an app that does not show the
server's instructions (Claude's apps), their key rules. `read_memory`
`every` carries those rules at the end of its text for such an app. The
first block is the answer as before (`describe`'s JSON stays parseable): a
client that reads `content[0]` is unaffected; one that joins every block
gets the extra lines too.

## Entry tools per tier: call_tool_read, call_tool_write, call_tool_destructive

Some clients (Claude's voice mode on iOS) ask before every call to a tool
annotated `destructiveHint: true`, even one the owner always allows. Every
PCP call went through `call_tool` or `run_code`, both destructive, so every
call asked. Each tool now has a tier, and each tier its own entry tools.

### Renamed tools (no old names kept)

| Old tool              | New tools                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `call_read_only_tool` | `call_tool_read`                                                                            |
| `call_tool`           | `call_tool_read`, `call_tool_write` or `call_tool_destructive`, by the tool's tier          |
| `run_code`            | `run_code_read`, `run_code_write` or `run_code_destructive`, by the tiers the program calls |

The old names are gone: a client that still calls them gets "unknown tool".
The new entries take the same arguments as the old ones did (the same
`call_handle` from describe, for every tier), and answer the same.

### Tiers

- **Read** (`readOnlyHint: true`), **Write** (`readOnlyHint: false`,
  `destructiveHint: false`) and **Destructive** (anything else). A tool
  with no hints, or only `readOnlyHint: false`, is Destructive, as MCP's
  defaults say.
- A wrapper's tool is the highest tier of the tools it calls; what its
  definition declares is only a proposal.
- The owner can set a tool's tier (Read, Write or Destructive) on its
  server's page, for every server of the same definition, and the tier PCP's
  own tools advertise on Settings → PCP's own tools. An assistant proposes
  tiers with `propose_tool_access`'s new `tier` (`read`, `write`,
  `destructive` or `default`), saved only on the request's page.
- Each `call_tool_<tier>` runs tools at or below its tier; a tool above is
  refused (`forbidden`) naming the entry that runs it, before its arguments
  are checked or the owner asked. A `run_code_<tier>` program's `pcp.call`
  to a tool above refuses with an error the program may catch.
- describe gives each tool's `tier` and `run_with` (the entry); list_tools
  and search lines end the level with the tier and its entry
  (`[allowed, write: call_tool_write]`); pcp.tools and pcp.describe give
  `tier` and `run_with` (a `run_code_<tier>`).
- The request log names the entry a call came through (`call_tool_write`,
  `run_code_read`).

### API endpoints state both hints

PCP's tools for an API state both hints: GET is Read (`readOnlyHint: true`,
`destructiveHint: false`), POST, PUT and PATCH are Write (`readOnlyHint:
false`, `destructiveHint: false`; before, POST, PUT and PATCH left
`destructiveHint` out, which read as destructive), DELETE is Destructive.

## The families behind call_tool on the same interface

The browser, mail and calendar accounts, SSH servers and services define
their tools on PCP's one tool interface, and every way a call reaches one
(call_tool, run_code's `pcp.call`, a wrapper's or browser flow's program,
the owner's answer) checks its arguments with the one validator before
anything connects or the owner is asked.

### Renamed arguments (old names accepted for one release)

| Tool                                                                          | Old name               | New name          |
| ----------------------------------------------------------------------------- | ---------------------- | ----------------- |
| mail `search_emails`                                                          | `allMailboxes`         | `all_mailboxes`   |
| mail `search_emails`                                                          | `hasAttachment`        | `has_attachment`  |
| mail `search_emails`                                                          | `notKeyword`           | `not_keyword`     |
| mail `get_thread`                                                             | `threadId`             | `thread_id`       |
| mail `send_email`, `create_draft`                                             | `inReplyTo`            | `in_reply_to`     |
| mail `mark_email`                                                             | `addKeywords`          | `add_keywords`    |
| mail `mark_email`                                                             | `removeKeywords`       | `remove_keywords` |
| calendar `create_event`, `update_event`, `create_reminder`, `update_reminder` | `recurrence.monthDays` | `month_days`      |

An answer to a call that used an old name starts with "hasAttachment was
renamed to has_attachment; use has_attachment.". A wrapper or browser flow
whose program uses one still works this release, and its answer says what
to change: "The wrapper W's tool T calls mail/search_emails with
hasAttachment, which was renamed to has_attachment (it works until the next
release): fix it with update_wrapper (edit tool T's program: replace
`hasAttachment` with `has_attachment`)." After the release the old name is
refused with the same fix. What the tools answer keeps its names
(`threadId`, `messageId` in an email).

Passing an old name and its new one together is refused; so is find's
`query` with `text`, which stays another name for it.

### Answers that read differently

- An unknown tool, a writing tool on a read-only account and arguments
  that do not fit are tool errors (`isError`, code `not_found`,
  `forbidden` or `invalid_arguments` in `_meta["gg.pcp/error"]`) with every
  problem named, not a thrown error: a run_code program still sees them as
  an Error. A rule across arguments says so in its words ("Give a ref or a
  target, one of them.") and is in the published schema, under `allOf`.
- Arguments are checked as strictly as PCP's own (lengths, patterns,
  formats, a closed object): a key a tool does not take is refused, never
  ignored, and a wrapper whose call no longer fits is refused with "The
  wrapper W's tool T needs migrating: fix it with update_wrapper ...".
- A JSON-RPC error an MCP server answers with (an unknown argument, say) is
  a tool error in its words ("S answered T with an error (JSON-RPC
  -32602): …"), coded `invalid_arguments` for -32602 and `not_found` for
  -32601. Before, it read "could not be reached", marked the server down
  and added that the call may have gone through; now only a failure on the
  way does.
- An API endpoint's JSON answer that is not an object (a list, a number)
  is `structuredContent` as it is, no longer `{"value": …}`.
- A wrapper tool with an outputSchema answers its value as
  `structuredContent`, checked as strictly as arguments are; `describe`
  shows a declared output schema as `outputSchema` (wrappers, MCP servers,
  SSH's `run_command`) instead of the `returns` outline, which stays for
  API endpoints. It shows an MCP server's tool icons too.
- An endpoint whose kept schema no longer builds with this PCP answers
  describe and call_tool with "This endpoint needs migrating: <problem>.
  Fix it with update_endpoint's add_patches: <edits>".

### Call handles

The families' published schemas changed (closed objects, rules under
`allOf`, snake_case names, prefixItems for an OpenAPI tuple), so their
`call_handle`s go stale once: describe the tool again.

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
  `{"kind": "needs_owner", "reason": "permission" | "connect" | "upload",
"url", "label", …}`, on every tool. A permission request names its id in
  `request`; a server to connect has `connect` (its links) and, from
  `check_server`, `server`; an upload link (`create_upload_link`) has
  `upload` (its id for `check_upload`, its files and its time). This replaces `{"kind": "connect", …}`. Its
  `message` is the whole text (what the owner is asked, and how to hand
  the link over), for a client that shows `structuredContent` in place of
  the text.
- `check_server`, `check_permission`, `register_server`,
  `propose_tool_access`, `update_endpoint`, `get_endpoint`, `list_secrets`,
  the wrapper tools, `share_result`, `receive_file`, `create_upload_link`
  and `check_upload` declare an
  `outputSchema`, and their answers carry matching `structuredContent`.
  `check_permission` answers `{"kind": "done", "request", "status",
"result", "server"?}` once a request is settled (`result` is what it came
  to in words: for a call that ran, its answer) and `{"kind": "requests",
"requests": […]}` without an id; `check_server` answers `{"kind": "done",
"server", "message"}` once connected. A declared answer's notes (a renamed
  argument) are also in `_meta["gg.pcp/notes"]`.
- A tool that declares no `outputSchema` (`call_tool`, `run_code`, …)
  sends `structuredContent` only when its text is that value's JSON and
  nothing more; when PCP's text says more (a note, a lead, a preview), the
  text alone is the answer.
- A refusal PCP writes carries its code in `_meta["gg.pcp/error"]`
  (`{"code": "not_found" | "forbidden" | "invalid_arguments" |
"rate_limited" | "timeout" | "browser_busy" | "internal" | …, "hint"?,
"retryAfterMs"?}`). The browser's `timeout` (a call past its `timeout_ms`,
  or the 10 seconds `tabs` open, `navigate` and `snapshot` now wait by
  default) and `browser_busy` (with `retryAfterMs`) are new.

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
