import { ChevronLeft } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

/**
 * The top of a page: a link back to where it sits (on a page under
 * another), an optional icon tile, the large title with a grey line under
 * it, and the page's own action at the right. DESIGN.md › Pages.
 */
export function PageHeader({
  title,
  description,
  action,
  back,
  icon,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  back?: { href: string; label: string }
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-5">
      {back ? (
        <Link
          href={back.href}
          className="-ml-1 inline-flex items-center gap-0.5 self-start text-sm text-primary hover:text-accent-foreground"
        >
          <ChevronLeft aria-hidden className="size-4" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-4">
          {icon}
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-[28px] leading-tight font-bold tracking-[-0.02em] break-words sm:text-[30px]">
              {title}
            </h1>
            {description ? (
              <div className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {description}
              </div>
            ) : null}
          </div>
        </div>
        {action ? (
          <div className="flex flex-wrap items-center gap-2">{action}</div>
        ) : null}
      </div>
    </div>
  )
}
