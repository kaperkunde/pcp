"use client"

import { useFormStatus } from "react-dom"

import { Button } from "@/components/ui/button"

/** A submit button that says so while the action runs. */
export function SubmitButton({
  children,
  pendingText,
  variant,
  size,
  className,
}: {
  children: React.ReactNode
  pendingText?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
}) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
    >
      {pending && pendingText ? pendingText : children}
    </Button>
  )
}
