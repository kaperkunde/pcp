"use client"

import { useState, useTransition } from "react"

import { FormError } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import { decidePermissionAction } from "@/lib/actions/permissions"
import type { PermissionDecision as Decision } from "@/lib/core/constants"
import { cn } from "@/lib/utils"

/**
 * The owner's buttons for something an assistant asked for. Answering runs
 * the call there and then; the page around it re-renders with the outcome.
 */
export function PermissionDecision({
  id,
  decisions,
}: {
  id: string
  decisions: Array<{ value: Decision; label: string }>
}) {
  const [pending, startTransition] = useTransition()
  const [chosen, setChosen] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{
    message: string
    isError: boolean
  } | null>(null)

  function decide(value: Decision) {
    setChosen(value)
    setError(null)

    startTransition(async () => {
      const result = await decidePermissionAction(id, value)

      if (result.status === "error") {
        setError(result.error)
      } else if (result.status === "ok") {
        setDone({ message: result.message, isError: result.isError })
      }
    })
  }

  if (done) {
    return (
      <p
        className={cn(
          "whitespace-pre-wrap break-words",
          done.isError && "text-destructive",
        )}
        data-testid="permission-outcome"
      >
        {done.message}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError error={error} />
      <div className="flex flex-wrap gap-2">
        {decisions.map((decision, index) => (
          <Button
            key={decision.value}
            type="button"
            size="sm"
            variant={
              decision.value === "block"
                ? "destructive"
                : index === 0
                  ? "default"
                  : "outline"
            }
            disabled={pending}
            onClick={() => decide(decision.value)}
          >
            {pending && chosen === decision.value ? "Working…" : decision.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
