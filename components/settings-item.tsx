import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Disclosure } from "@/components/ui/disclosure"
import { IconTile } from "@/components/ui/icon-tile"

/**
 * One setting on the Settings page. In a List it is a folded row: the title,
 * a grey line with its current state, and the form inside, opening in place.
 * As a `card` (the same forms on the setup steps, outside a List) it is a
 * titled panel with the form showing. `id` is the anchor other pages link to
 * (/settings#updates): it sits inside the row, so the browser opens the row
 * when it is the target, and `defaultOpen` opens it when the page knows the
 * owner needs it (an update is out, a certificate failed).
 */
export function SettingsItem({
  variant = "row",
  id,
  title,
  icon,
  tint,
  state,
  about,
  defaultOpen,
  children,
}: {
  variant?: "row" | "card"
  id?: string
  title: string
  icon?: LucideIcon
  /** Tailwind classes that tint the icon tile; neutral when left out. */
  tint?: string
  /** The grey line under the title of a row: what it is now. */
  state?: ReactNode
  /** What it is for, above the form. */
  about?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  if (variant === "card") {
    return (
      <Card id={id} className="scroll-mt-6">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {about ? <CardDescription>{about}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    )
  }

  return (
    <Disclosure
      inList
      title={title}
      description={state}
      icon={icon ? <IconTile icon={icon} size="sm" className={tint} /> : null}
      defaultOpen={defaultOpen}
    >
      <div id={id} className="flex scroll-mt-6 flex-col gap-4">
        {about ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {about}
          </p>
        ) : null}
        {children}
      </div>
    </Disclosure>
  )
}
