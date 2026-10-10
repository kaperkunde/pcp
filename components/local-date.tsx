"use client"

import { useEffect, useState } from "react"

import { timeAgo } from "@/lib/utils"

/** A timestamp in the reader's locale, rendered after hydration. */
export function LocalDate({ value }: { value: Date | string | null }) {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    if (value) {
      setText(new Date(value).toLocaleString())
    }
  }, [value])

  if (!value) {
    return <span className="text-muted-foreground">never</span>
  }

  return (
    <time dateTime={new Date(value).toISOString()} suppressHydrationWarning>
      {text ?? new Date(value).toISOString().slice(0, 16).replace("T", " ")}
    </time>
  )
}

/**
 * How long ago, "3 min ago", rendered after hydration so the server's clock
 * never shows; the full date is its tooltip.
 */
export function RelativeDate({
  value,
  never = "never",
}: {
  value: Date | string | null
  never?: string
}) {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    if (value) {
      setText(timeAgo(value))
    }
  }, [value])

  if (!value) {
    return <span>{never}</span>
  }

  const date = new Date(value)

  return (
    <time
      dateTime={date.toISOString()}
      title={date.toISOString().slice(0, 16).replace("T", " ")}
      suppressHydrationWarning
    >
      {text ?? date.toISOString().slice(0, 10)}
    </time>
  )
}
