"use client"

import { ChevronDown } from "lucide-react"
import Link from "next/link"
import { useActionState, useId, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import { List, ListSection } from "@/components/ui/list"
import {
  setToolDescriptionAction,
  type ServerActionResult,
} from "@/lib/actions/servers"
import { showReplacedToolAction } from "@/lib/actions/wrappers"
import type { ServerKind } from "@/lib/core/servers"
import { cn } from "@/lib/utils"

export type ServerTool = {
  name: string
  title: string | null
  description: string
  descriptionOverride: string | null
  /** An API endpoint's tool: the request it makes. */
  operation: { method: string; path: string } | null
  /** Wrappers' tools that stand in for this one in search. */
  replacedBy?: Array<{ id: string; name: string; tool: string }>
}

/** How many tools the page shows before "Show all". */
const PREVIEW = 5

function about(kind: ServerKind): string {
  switch (kind) {
    case "openapi":
      return "What an assistant can find with search_tools. Each one is an operation from the schema; rewrite a description when the schema's wording would not help it choose."
    case "jmap":
    case "imap":
      return "What an assistant can find with search_tools: the same mail tools for every account, less those a read-only account or one that cannot send leaves out."
    case "ssh":
      return "What an assistant can find with search_tools: run_command, one command per call. Leave it at ask, and you see each command before it runs."
    case "browser":
      return "What an assistant can find with search_tools: the browser's own tools. Allow the ones that only read a page, and keep the ones that act on it at ask until you trust the assistant there."
    case "wrapper":
      return "What an assistant can find with search_tools: each one runs its program. For a token, a tool here is blocked wherever a tool it calls is, and asks you wherever one of them asks."
    default:
      return "What an assistant can find with search_tools. Rewrite a description when the server's own wording would not help it choose."
  }
}

function none(kind: ServerKind): string {
  switch (kind) {
    case "openapi":
      return "No operations are offered yet. Re-read the schema, or replace it under Advanced."
    case "jmap":
    case "imap":
      return "No tools yet: PCP offers them once it has signed in. Check the settings under Advanced, then check the account again, or connect it."
    case "ssh":
      return "No tools yet: check the sign-in again."
    case "browser":
      return "No tools yet: check the browser again."
    default:
      return "No tools known yet. Connect the server, or refresh its tools."
  }
}

/**
 * A server's tools: the first few on the page, the rest one click away (a
 * server can bring hundreds). Each one's description can be rewritten in
 * the owner's words.
 */
export function ServerTools({
  serverId,
  kind,
  tools,
}: {
  serverId: string
  kind: ServerKind
  tools: ServerTool[]
}) {
  const [all, setAll] = useState(false)
  const listId = useId()
  const more = tools.length > PREVIEW
  const shown = all || !more ? tools : tools.slice(0, PREVIEW)
  const expanded = all || !more

  return (
    <ListSection
      title={
        // The count names the section for assistive technology and tests;
        // pressing it shows every tool, as "Show all" does.
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setAll((value) => !value)}
          disabled={!more}
          className="-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
        >
          Tools ({tools.length})
          {more ? (
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
          ) : null}
        </button>
      }
      action={
        more ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setAll((value) => !value)}
          >
            {all ? "Show fewer" : `Show all ${tools.length}`}
          </Button>
        ) : null
      }
      footer={about(kind)}
    >
      {tools.length === 0 ? (
        <List>
          <p className="px-4 py-4 text-[13px] text-muted-foreground">
            {none(kind)}
          </p>
        </List>
      ) : (
        <List as="ul" id={listId}>
          {shown.map((tool) => (
            <ToolRow key={tool.name} serverId={serverId} tool={tool} />
          ))}
        </List>
      )}
    </ListSection>
  )
}

function ToolRow({ serverId, tool }: { serverId: string; tool: ServerTool }) {
  const [editing, setEditing] = useState(false)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    setToolDescriptionAction,
    { status: "idle" },
  )
  const replaced = tool.replacedBy && tool.replacedBy.length > 0

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {tool.operation ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
              {tool.operation.method}
            </span>
          ) : null}
          <code className="text-[13px] break-all text-foreground">
            {tool.name}
          </code>
          {tool.title ? (
            <span className="text-xs text-muted-foreground">{tool.title}</span>
          ) : null}
          {tool.operation ? (
            <code className="text-xs break-all text-muted-foreground">
              {tool.operation.path}
            </code>
          ) : null}
          {tool.descriptionOverride ? (
            <Badge variant="default">edited</Badge>
          ) : null}
          {replaced ? (
            <Badge variant="secondary">Left out of search</Badge>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? "Cancel" : "Edit description"}
        </Button>
      </div>
      {editing ? (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="serverId" value={serverId} />
          <input type="hidden" name="tool" value={tool.name} />
          <Textarea
            name="description"
            defaultValue={tool.descriptionOverride ?? tool.description}
            aria-label={`Description of ${tool.name}`}
            maxLength={2000}
          />
          <p className="text-xs text-muted-foreground">
            What assistants read about it. Leave it empty to go back to the
            original description.
          </p>
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton size="sm" pendingText="Saving…">
              Save description
            </SubmitButton>
          </div>
        </form>
      ) : (tool.descriptionOverride ?? tool.description) ? (
        <p
          className="line-clamp-3 text-[13px] leading-relaxed whitespace-pre-line text-muted-foreground"
          title={tool.descriptionOverride ?? tool.description}
        >
          {tool.descriptionOverride ?? tool.description}
        </p>
      ) : null}
      {replaced ? (
        <ReplacedNote
          serverId={serverId}
          tool={tool.name}
          by={tool.replacedBy!}
        />
      ) : null}
    </li>
  )
}

/**
 * A tool a wrapper stands in for: assistants find the wrapper's instead, and
 * can still call this one by name. Showing it again takes it out of what
 * every wrapper replaces.
 */
function ReplacedNote({
  serverId,
  tool,
  by,
}: {
  serverId: string
  tool: string
  by: Array<{ id: string; name: string; tool: string }>
}) {
  const [state, action] = useActionState<ServerActionResult, FormData>(
    showReplacedToolAction,
    { status: "idle" },
  )

  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="tool" value={tool} />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Left out of search_tools and list_tools: assistants find{" "}
        {by.map((entry, index) => (
          <span key={`${entry.id}/${entry.tool}`}>
            {index > 0 ? ", " : null}
            <Link href={`/servers/${entry.id}`} className="text-primary">
              {entry.name}
            </Link>{" "}
            <code>{entry.tool}</code>
          </span>
        ))}{" "}
        instead. It can still be called by its name.
      </p>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
      <SubmitButton size="xs" variant="secondary" pendingText="Showing…">
        Show it in search again
      </SubmitButton>
    </form>
  )
}
