"use client"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A sheet over the page, for a short task that should not lose the page
 * behind it (connecting an assistant, adding a server). Base UI's dialog:
 * focus stays inside, Escape closes, the title names it.
 */
const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/60 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogPrimitive.Popup
        className={cn(
          "fixed top-[min(10vh,72px)] left-1/2 z-50 flex max-h-[calc(100vh-2*min(10vh,72px))] w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2 flex-col gap-5 overflow-y-auto rounded-[18px] bg-[#1a1f27] p-7 text-sm text-foreground shadow-[0_30px_80px_#000000b0,inset_0_0_0_1px_#ffffff14] outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("text-2xl leading-tight font-bold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

/** The buttons at a sheet's foot: the primary one last, at the right. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap justify-end gap-2 pt-1", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
}
