"use client"

import { useEffect, useState } from "react"

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
