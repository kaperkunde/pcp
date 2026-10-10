import { ChevronRight } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The grouped list: rows on one rounded panel, a hairline between them, as
 * in the Mac's settings. Most of PCP is lists of these. DESIGN.md › Lists.
 *
 * `as="ul"` makes it a list for assistive technology (and for a test's
 * getByRole("listitem")); its rows are then `as="li"`.
 */
function List({
  as: Tag = "div",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "div" | "ul" | "ol" }) {
  return (
    <Tag
      data-slot="list"
      className={cn(
        "m-0 flex list-none flex-col divide-y divide-separator overflow-hidden rounded-xl bg-card p-0",
        className,
      )}
      {...props}
    />
  )
}

/**
 * A titled group: the small grey label above a list (or a card), an
 * optional action at the label's right and a caption under it.
 */
function ListSection({
  title,
  description,
  action,
  footer,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  footer?: React.ReactNode
}) {
  const id = React.useId()

  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      {title || action ? (
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-1">
          <div className="flex flex-col gap-1">
            {title ? (
              <h2
                id={id}
                className="text-[13px] font-semibold tracking-normal text-muted-foreground"
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
      {footer ? (
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {footer}
        </p>
      ) : null}
    </section>
  )
}

const rowClassName =
  "flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5 text-sm"

/**
 * One row: an optional icon, a title with a grey line under it, and what
 * sits at the right (a value, a button, a switch). With `href` the whole
 * row is a link and ends in a chevron.
 */
function ListRow({
  as: Tag = "div",
  icon,
  title,
  description,
  trailing,
  href,
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  as?: "div" | "li"
  icon?: React.ReactNode
  title?: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  href?: string
}) {
  const body = (
    <>
      {icon}
      {title !== undefined || description !== undefined ? (
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
          {title !== undefined ? (
            <span className="text-[15px] leading-snug text-foreground">
              {title}
            </span>
          ) : null}
          {description ? (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
      {trailing}
    </>
  )

  if (href) {
    return (
      <Tag data-slot="list-row" {...props}>
        <Link
          href={href}
          className={cn(
            rowClassName,
            "flex-nowrap text-foreground transition-colors outline-none hover:bg-row-hover focus-visible:bg-row-hover",
            className,
          )}
        >
          {body}
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground/60"
          />
        </Link>
      </Tag>
    )
  }

  return (
    <Tag
      data-slot="list-row"
      className={cn(rowClassName, className)}
      {...props}
    >
      {body}
    </Tag>
  )
}

/** A grey value at a row's right ("Never", "2 devices"). */
function RowValue({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("text-[13px] text-muted-foreground", className)}
      {...props}
    />
  )
}

export { List, ListSection, ListRow, RowValue }
