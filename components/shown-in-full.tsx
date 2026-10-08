import type { ShownText } from "@/lib/core/permission-rules"

/**
 * Everything a request carries (lib/core/permission-rules.ts), folded under
 * its lines when they cut it short or wrote out what is in it: each part
 * whole, as it runs when the owner allows it. Runs of spaces take their room,
 * so nothing can sit out of sight at the end of a line.
 */
export function ShownInFull({ parts }: { parts: ShownText[] }) {
  return (
    <details className="rounded-md border p-3" data-testid="shown-in-full">
      <summary className="cursor-pointer">Show everything</summary>
      <div className="mt-3 flex flex-col gap-3">
        {parts.map((part, index) => (
          <section key={index} className="flex flex-col gap-1">
            <h3 className="text-sm font-medium break-all">{part.label}</h3>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs break-all whitespace-break-spaces">
              {part.text}
            </pre>
          </section>
        ))}
      </div>
    </details>
  )
}
