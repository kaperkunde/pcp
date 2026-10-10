import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import Link from "next/link"
import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One primary action per view (`default`, teal); everything else is a
 * filled grey (`secondary`, and `outline`, kept as its alias) or plain text
 * (`ghost` in the accent colour, `plain` in grey, `destructive` in red).
 * DESIGN.md › Buttons.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-[13px] font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary font-semibold text-primary-foreground hover:bg-primary/85",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[#2f3642] hover:text-white",
        outline:
          "bg-secondary text-secondary-foreground hover:bg-[#2f3642] hover:text-white",
        ghost: "text-primary hover:bg-primary/10",
        plain:
          "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        destructive:
          "text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/30",
        link: "h-auto px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 gap-1.5 px-3.5",
        xs: "h-7 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 rounded-md px-3 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 rounded-[11px] px-5 text-[15px]",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  render,
  nativeButton,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      render={render}
      // A button rendered as something else (a link) is not a native
      // <button>; saying so keeps Base UI from warning about it.
      nativeButton={nativeButton ?? render === undefined}
      {...props}
    />
  )
}

/** A navigation link that looks like a button and stays a link. */
function ButtonLink({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return (
    <Link
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, ButtonLink, buttonVariants }
