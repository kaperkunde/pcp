"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { Button } from "@kaperkunde/ui/button"
import { Select } from "@kaperkunde/ui/input"
import { ListRow } from "@kaperkunde/ui/list"
import { setClientProfileAction } from "@/lib/actions/tokens"
import type { ActionState } from "@/lib/server/action-state"

/**
 * Which app the token is answered as (lib/core/clients/profiles.ts): found
 * out from each request, or the one the owner picks when PCP guesses wrong.
 * The profiles come from the page, which reads them from the core.
 */
export function TokenClientProfile({
  tokenId,
  chosen,
  detectedLabel,
  profiles,
  locked,
}: {
  tokenId: string
  /** The owner's choice; null: detected. */
  chosen: string | null
  /** The profile the last request pointed at, for the "automatic" line. */
  detectedLabel: string
  profiles: Array<{ id: string; label: string }>
  locked: boolean
}) {
  const router = useRouter()
  const saved = chosen ?? "auto"
  const [value, setValue] = useState(saved)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState>({ status: "idle" })

  function save() {
    startTransition(async () => {
      const outcome = await setClientProfileAction(tokenId, value)
      setResult(outcome)
      if (outcome.status === "ok") router.refresh()
    })
  }

  return (
    <ListRow
      title="App"
      description="What PCP repeats in its answers for an app that does not show its instructions. Names and descriptions of tools stay the same."
      trailing={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="App this token is used from"
            value={value}
            disabled={locked || pending}
            onChange={(event) => setValue(event.target.value)}
            className="h-8 w-auto max-w-64 text-[13px]"
          >
            <option value="auto">
              Detect automatically (now: {detectedLabel})
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </Select>
          {locked ? null : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending || value === saved}
              onClick={save}
            >
              {pending ? "Saving…" : "Save app"}
            </Button>
          )}
          <FormError error={result.status === "error" ? result.error : null} />
          <FormNote
            message={
              result.status === "ok" && value === saved ? "Saved." : null
            }
          />
        </div>
      }
    />
  )
}
