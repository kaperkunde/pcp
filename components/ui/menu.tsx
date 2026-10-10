"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import Link from "next/link"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A popup list of choices under a button: the bell's requests, the Add
 * menu on Servers. Base UI's menu: arrow keys move, Escape closes.
 */
const Menu = MenuPrimitive.Root
const MenuTrigger = MenuPrimitive.Trigger

function MenuContent({
  className,
  align = "end",
  side = "bottom",
  children,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"]
  side?: MenuPrimitive.Positioner.Props["side"]
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="z-50 outline-none"
        sideOffset={8}
        align={align}
        side={side}
      >
        <MenuPrimitive.Popup
          className={cn(
            "flex w-80 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] flex-col rounded-[14px] bg-popover p-1.5 text-sm text-popover-foreground shadow-[0_20px_50px_#000000a0,inset_0_0_0_1px_#ffffff14] outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

const itemClassName =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2 text-left text-foreground outline-none data-highlighted:bg-[#2a303b]"

/** A choice that goes to a page. */
function MenuLinkItem({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <MenuPrimitive.LinkItem
      closeOnClick
      render={<Link href={href} />}
      className={cn(itemClassName, className)}
    >
      {children}
    </MenuPrimitive.LinkItem>
  )
}

/** A choice that does something here. */
function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item className={cn(itemClassName, className)} {...props} />
  )
}

function MenuSeparator({ className }: { className?: string }) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2 my-1.5 h-px bg-separator", className)}
    />
  )
}

/** A grey line of text inside the menu: a heading or a note. */
function MenuNote({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "px-3 py-2 text-xs leading-relaxed text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuLinkItem,
  MenuItem,
  MenuSeparator,
  MenuNote,
}
