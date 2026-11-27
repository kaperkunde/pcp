import { Checkbox } from "@kaperkunde/ui/input"
import { PROGRAM_TOOLS } from "@/lib/core/constants"

/**
 * The built-in tools of PCP a token's programs may call (#164): one box
 * each, all named `builtinTools`, read by createTokenAction,
 * updateTokenAction and the sign-in consent. None by default. A token that
 * reaches no server needs at least one: "Search the web" alone makes a
 * token that only searches.
 */
export function BuiltinToolFields({
  selected = [],
  idPrefix = "builtin",
}: {
  selected?: readonly string[]
  idPrefix?: string
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-4">
      <legend className="sr-only">Built-in tools</legend>
      <p className="text-xs leading-relaxed text-muted-foreground">
        PCP&apos;s own tools that this token&apos;s programs (run code and
        wrappers) may call, at the token&apos;s levels. Tick none to keep
        programs to your servers&apos; tools. Search the web also gives the
        assistant the web_search tool itself, and lets a token reach no server.
      </p>
      {PROGRAM_TOOLS.map((tool) => (
        <label
          key={tool.name}
          htmlFor={`${idPrefix}-${tool.name}`}
          className="flex cursor-pointer items-start gap-2 text-sm"
        >
          <Checkbox
            id={`${idPrefix}-${tool.name}`}
            name="builtinTools"
            value={tool.name}
            defaultChecked={selected.includes(tool.name)}
            className="mt-0.5"
          />
          <span className="flex min-w-0 flex-col">
            <span>{tool.label}</span>
            <span className="text-xs text-muted-foreground">
              {tool.caption}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
