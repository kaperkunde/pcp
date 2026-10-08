import { cn } from "@/lib/utils"

/** "Server: Postcards (https://…)": a short name, a colon, the rest. */
const KEY_VALUE = /^([A-Za-z][A-Za-z0-9 _./-]{0,30}):[ \n]([\s\S]+)$/

/** What the request says about who asked, shown quieter than what it does. */
const ASKER = /^Asked by the token /

/**
 * What will happen, as a readable list: each line of the request on a row
 * of its own, a line that names a thing ("Address: …", "a: 19") as the
 * name in grey and the value beside it. Every line is shown whole, as the
 * request wrote it: nothing here is cut or folded.
 */
export function PermissionLines({ lines }: { lines: string[] }) {
  return (
    <ul
      className="m-0 flex list-none flex-col divide-y divide-separator overflow-hidden rounded-xl bg-field p-0 ring-1 ring-separator"
      data-testid="permission-lines"
    >
      {lines.map((line, index) => {
        const asker = ASKER.test(line)
        const match = asker ? null : KEY_VALUE.exec(line)

        return (
          <li
            key={index}
            className={cn(
              "px-4 py-3 break-words whitespace-pre-wrap",
              match
                ? "grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-baseline sm:gap-4"
                : asker && "text-[13px] text-muted-foreground",
            )}
          >
            {match ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {match[1]}
                </span>
                <span className="break-words">{match[2]}</span>
              </>
            ) : (
              line
            )}
          </li>
        )
      })}
    </ul>
  )
}
