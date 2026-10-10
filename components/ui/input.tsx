import * as React from "react"

import { cn } from "@/lib/utils"

const inputClassName =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-field px-3 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputClassName, className)}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(inputClassName, "h-auto min-h-20 py-2", className)}
      {...props}
    />
  )
}

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(inputClassName, "cursor-pointer bg-secondary", className)}
      {...props}
    />
  )
}

function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn("size-4 cursor-pointer accent-primary", className)}
      {...props}
    />
  )
}

export { Input, Textarea, Select, Checkbox }
