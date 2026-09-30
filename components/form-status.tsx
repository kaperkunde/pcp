import { cn } from "@/lib/utils"

/** The error under a form, or the note that it worked. */
export function FormError({
  error,
  className,
}: {
  error: string | null | undefined
  className?: string
}) {
  if (!error) {
    return null
  }

  return (
    <p className={cn("text-sm text-destructive", className)} role="alert">
      {error}
    </p>
  )
}

export function FormNote({
  message,
  className,
}: {
  message: string | null | undefined
  className?: string
}) {
  if (!message) {
    return null
  }

  return (
    <p className={cn("text-sm text-muted-foreground", className)} role="status">
      {message}
    </p>
  )
}
