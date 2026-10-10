import { KeyRound } from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import type { WrapperShown, WrapperShownTool } from "@/lib/core/wrappers/admin"
import { cn } from "@/lib/utils"

const STATUS: Record<WrapperShownTool["status"], string> = {
  new: "New",
  changed: "Changed",
  removed: "Removed",
  same: "Unchanged",
}

/** A wrapper tool's hints (MCP annotations), in the owner's words. */
const HINTS: Record<string, [string, string]> = {
  readOnlyHint: ["Only reads", "Changes data"],
  destructiveHint: ["Can delete or overwrite", "Does not delete"],
  idempotentHint: ["Same result when repeated", "Acts again when repeated"],
  openWorldHint: ["Reaches outside services", "Stays within its servers"],
}

/** What JSON Schema types are called on the page. */
const TYPES: Record<string, string> = {
  string: "text",
  number: "number",
  integer: "whole number",
  boolean: "yes or no",
  array: "list",
  object: "object",
}

/**
 * A wrapper as an assistant asks for it (lib/core/wrappers/admin.ts): every
 * tool's program and arguments in full, what it calls and stands in for,
 * and where each secret goes. The owner reads it whole before agreeing, so
 * nothing new or changed is folded: only tools that stay as they are, and
 * the program a changed one had before.
 */
export function WrapperReview({ shown }: { shown: WrapperShown }) {
  const open = shown.tools.filter((tool) => tool.status !== "same")
  const same = shown.tools.filter((tool) => tool.status === "same")

  return (
    <div className="flex flex-col gap-4">
      {shown.secrets.length > 0 ? <SecretPlaces shown={shown} /> : null}
      {open.map((tool) => (
        <ToolReview key={tool.name} tool={tool} />
      ))}
      {same.length > 0 ? (
        <details className="group/same overflow-hidden rounded-xl border border-input bg-card">
          <summary className="flex min-h-12 cursor-pointer items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground hover:bg-row-hover">
            {same.length} unchanged tool{same.length === 1 ? "" : "s"}:{" "}
            <span className="font-mono text-foreground">
              {same.map((tool) => tool.name).join(", ")}
            </span>
          </summary>
          <div className="flex flex-col gap-4 border-t border-separator p-4">
            {same.map((tool) => (
              <ToolReview key={tool.name} tool={tool} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function SecretPlaces({ shown }: { shown: WrapperShown }) {
  return (
    <section
      aria-labelledby="wrapper-secret-places"
      className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-card px-4 py-4 sm:px-5"
    >
      <h3
        id="wrapper-secret-places"
        className="flex items-center gap-2 text-[13px] font-semibold text-warning"
      >
        <KeyRound aria-hidden className="size-4" strokeWidth={1.8} />
        Where your secrets go
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-1.5 pr-4 font-medium">Secret</th>
              <th className="py-1.5 pr-4 font-medium">Into</th>
              <th className="py-1.5 pr-4 font-medium">Written as</th>
              <th className="py-1.5 font-medium">Only while at</th>
            </tr>
          </thead>
          <tbody className="align-baseline">
            {shown.secrets.map((binding, index) => (
              <tr key={index} className="border-t border-separator">
                <td className="py-2 pr-4 break-words">
                  <span className="font-medium">{binding.secret}</span>
                  {binding.isNew ? (
                    <span className="block text-xs text-warning">
                      New: type its value in below
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 break-all">
                  <code>{binding.tool}</code> <code>{binding.argument}</code>
                </td>
                <td className="py-2 pr-4 break-all">
                  <code>{binding.template}</code>
                </td>
                <td className="py-2 break-all">
                  <code>{binding.url}</code>
                  <span className="block text-xs text-muted-foreground">
                    {binding.serverName}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        PCP writes each value in at these places only, for the server at that
        address. Neither the program nor the assistant ever sees it.
      </p>
    </section>
  )
}

function ToolReview({ tool }: { tool: WrapperShownTool }) {
  const lines = tool.program.split("\n").length

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-input bg-card",
        tool.status === "removed" && "opacity-80",
      )}
    >
      <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h3 className="text-[15px] font-semibold">
            {tool.title ?? <code>{tool.name}</code>}
          </h3>
          {tool.title ? (
            <code className="text-[13px] text-muted-foreground">
              {tool.name}
            </code>
          ) : null}
          <Badge variant={tool.status === "same" ? "secondary" : "warning"}>
            {STATUS[tool.status]}
          </Badge>
          <Hints annotations={tool.annotations} />
        </div>
        <p className="leading-relaxed break-words whitespace-pre-wrap">
          {tool.description}
        </p>
      </div>

      {tool.status === "removed" ? null : (
        <Part label="Takes">
          <Arguments schema={tool.inputSchema} />
        </Part>
      )}

      <Part label="Calls">
        <Chips names={tool.calls} />
      </Part>

      {tool.replaces.length > 0 ? (
        <Part label="Stands in for">
          <Chips names={tool.replaces} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Left out of search for every assistant while the wrapper stands in
            for them. They can still be called by name.
          </p>
        </Part>
      ) : null}

      {tool.status === "removed" ? null : (
        <Part label={`Program · ${lines} line${lines === 1 ? "" : "s"}`}>
          <Code>{tool.program}</Code>
          {tool.previousProgram !== null ? (
            <details>
              <summary className="cursor-pointer text-[13px] text-muted-foreground hover:text-foreground">
                The program before
              </summary>
              <Code className="mt-2">{tool.previousProgram}</Code>
            </details>
          ) : null}
        </Part>
      )}
    </article>
  )
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-separator px-4 py-3.5 sm:px-5">
      <h4 className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {label}
      </h4>
      {children}
    </section>
  )
}

function Chips({ names }: { names: string[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {names.map((name) => (
        <li
          key={name}
          className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground"
        >
          {name}
        </li>
      ))}
    </ul>
  )
}

function Code({
  className,
  children,
}: {
  className?: string
  children: string
}) {
  return (
    <pre
      className={cn(
        "m-0 max-h-[32rem] overflow-auto rounded-[9px] bg-field p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground",
        className,
      )}
    >
      {children}
    </pre>
  )
}

function Hints({ annotations }: { annotations: string | null }) {
  if (!annotations) {
    return null
  }

  let hints: Record<string, unknown>

  try {
    hints = JSON.parse(annotations) as Record<string, unknown>
  } catch {
    hints = {}
  }

  const entries = Object.entries(hints)
  const known = entries.every(
    ([key, value]) => key in HINTS && typeof value === "boolean",
  )

  if (!known || entries.length === 0) {
    // Not the four hints the definition allows: shown as given.
    return (
      <code className="text-xs text-muted-foreground break-all">
        {annotations}
      </code>
    )
  }

  return (
    <>
      {entries.map(([key, value]) => {
        const [yes, no] = HINTS[key]!
        const warn =
          (key === "readOnlyHint" && value === false) ||
          (key === "destructiveHint" && value === true)

        return (
          <Badge
            key={key}
            variant={warn ? "warning" : "secondary"}
            title={`${key}: ${String(value)}`}
          >
            {value ? yes : no}
          </Badge>
        )
      })}
    </>
  )
}

type Property = { type?: string; description?: string }

/**
 * A tool's input schema as a table of its arguments, when that says all of
 * it; any other schema is shown whole, as JSON.
 */
function Arguments({ schema }: { schema: string }) {
  const rows = simpleArguments(schema)

  if (!rows) {
    return <Code>{schema}</Code>
  }

  if (rows.length === 0) {
    return <p className="text-[13px] text-muted-foreground">No arguments.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <tbody className="align-baseline">
          {rows.map((row) => (
            <tr
              key={row.name}
              className="border-t border-separator first:border-t-0"
            >
              <td className="w-[1%] py-2 pr-6 font-mono whitespace-nowrap">
                {row.name}
              </td>
              <td className="w-[1%] py-2 pr-6 text-xs whitespace-nowrap text-muted-foreground">
                {row.type}
                {row.required ? " · needed" : null}
              </td>
              <td className="py-2 text-xs break-words text-muted-foreground">
                {row.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The arguments of an object schema whose properties carry only a plain
 * type and a description, or null when the schema says more than a table
 * of those would show.
 */
function simpleArguments(schema: string): Array<{
  name: string
  type: string
  required: boolean
  description: string
}> | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(schema)
  } catch {
    return null
  }

  if (!isRecord(parsed) || parsed.type !== "object") {
    return null
  }

  if (
    Object.keys(parsed).some(
      (key) => !["type", "properties", "required"].includes(key),
    )
  ) {
    return null
  }

  const properties = parsed.properties ?? {}
  const required = parsed.required ?? []

  if (
    !isRecord(properties) ||
    !Array.isArray(required) ||
    required.some((name) => typeof name !== "string" || !(name in properties))
  ) {
    return null
  }

  const rows = []

  for (const [name, value] of Object.entries(properties)) {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => key !== "type" && key !== "description")
    ) {
      return null
    }

    const property = value as Property

    if (
      typeof property.type !== "string" ||
      !(property.type in TYPES) ||
      (property.description !== undefined &&
        typeof property.description !== "string")
    ) {
      return null
    }

    rows.push({
      name,
      type: TYPES[property.type]!,
      required: required.includes(name),
      description: property.description ?? "",
    })
  }

  return rows
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
