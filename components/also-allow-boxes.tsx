"use client"

import { Checkbox } from "@kaperkunde/ui/input"
import { Label } from "@kaperkunde/ui/label"
import type { AlsoAllow } from "@/lib/core/secret-scope-asks"

/**
 * "Also allow <secret> for <consumer>", one box each, ticked to start: what
 * a request or a repository's item would let use one of your secrets
 * outside where you let it be used so far (#162). Agreeing needs each
 * ticked, and adds exactly those to the secret's scope.
 */
export function AlsoAllowBoxes({
  alsoAllows,
  kept,
  onChange,
  disabled = false,
}: {
  alsoAllows: AlsoAllow[]
  kept: string[]
  onChange: (kept: string[]) => void
  disabled?: boolean
}) {
  if (alsoAllows.length === 0) {
    return null
  }

  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend className="mb-2 text-sm font-medium">
        Your secrets this uses
      </legend>
      <p className="m-0 text-sm text-muted-foreground">
        Each is outside where you let it be used so far. Agreeing adds it there;
        you can change that under Secrets.
      </p>
      {alsoAllows.map((also) => (
        <Label key={also.key} className="items-start font-normal">
          <Checkbox
            className="mt-0.5"
            checked={kept.includes(also.key)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...kept, also.key]
                  : kept.filter((key) => key !== also.key),
              )
            }
            disabled={disabled}
          />
          <span className="break-words">
            Also allow &quot;{also.secretName}&quot; for {also.consumer}
          </span>
        </Label>
      ))}
    </fieldset>
  )
}
