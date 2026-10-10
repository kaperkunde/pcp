"use client"

import { Check, Copy } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"

/** A value on its own line with a copy button, for tokens and addresses. */
export function CopyableValue({
  value,
  label = "Copy",
  testId,
}: {
  value: string
  label?: string
  testId?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (plain http, permissions): the value is on
      // screen to select by hand.
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[9px] bg-field py-1.5 pr-1.5 pl-3">
      <code
        className="min-w-0 flex-1 text-[13px] break-all text-foreground"
        data-testid={testId}
      >
        {value}
      </code>
      <Button type="button" variant="secondary" size="sm" onClick={copy}>
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {copied ? "Copied" : label}
      </Button>
    </div>
  )
}
