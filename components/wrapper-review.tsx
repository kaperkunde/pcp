import { Badge } from "@/components/ui/badge"
import type { WrapperShown, WrapperShownTool } from "@/lib/core/wrappers/admin"

const STATUS: Record<WrapperShownTool["status"], string> = {
  new: "New",
  changed: "Changed",
  removed: "Removed",
  same: "Unchanged",
}

/**
 * A wrapper as an assistant asks for it (lib/core/wrappers/admin.ts): every
 * tool's program and schema in full, what it calls and stands in for, and
 * where each secret goes. Unchanged tools are folded away; a changed
 * program shows what it was.
 */
export function WrapperReview({ shown }: { shown: WrapperShown }) {
  const open = shown.tools.filter((tool) => tool.status !== "same")
  const same = shown.tools.filter((tool) => tool.status === "same")

  return (
    <div className="flex flex-col gap-4">
      {shown.secrets.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Where your secrets go</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 break-words">
            {shown.secrets.map((binding, index) => (
              <li key={index}>
                <strong>{binding.secret}</strong>
                {binding.isNew
                  ? " (new: type its value in below)"
                  : null} into <code>{binding.argument}</code> of{" "}
                <code>{binding.tool}</code> ({binding.serverName}, {binding.url}
                ), written as <code>{binding.template}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {open.map((tool) => (
        <ToolReview key={tool.name} tool={tool} />
      ))}
      {same.length > 0 ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer">
            {same.length} unchanged tool{same.length === 1 ? "" : "s"}:{" "}
            {same.map((tool) => tool.name).join(", ")}
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {same.map((tool) => (
              <ToolReview key={tool.name} tool={tool} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function ToolReview({ tool }: { tool: WrapperShownTool }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono font-medium">{tool.name}</h3>
        <Badge variant={tool.status === "same" ? "outline" : "warning"}>
          {STATUS[tool.status]}
        </Badge>
        {tool.annotations ? (
          <span className="text-xs text-muted-foreground">
            {tool.annotations}
          </span>
        ) : null}
      </div>
      {tool.title ? <p className="font-medium">{tool.title}</p> : null}
      <p className="break-words whitespace-pre-wrap">{tool.description}</p>
      <p className="text-sm break-words">
        Calls: <code>{tool.calls.join(", ")}</code>
      </p>
      {tool.replaces.length > 0 ? (
        <p className="text-sm break-words">
          Stands in for, in search: <code>{tool.replaces.join(", ")}</code>
        </p>
      ) : null}
      {tool.status === "removed" ? null : (
        <>
          <p className="text-sm text-muted-foreground">Program</p>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {tool.program}
          </pre>
          {tool.previousProgram !== null ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                The program before
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                {tool.previousProgram}
              </pre>
            </details>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Its arguments (input schema)
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
              {tool.inputSchema}
            </pre>
          </details>
        </>
      )}
    </section>
  )
}
