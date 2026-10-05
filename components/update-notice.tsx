import { CircleArrowUp } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"

/**
 * The header's note that a newer PCP is out, beside the version. It leads
 * to Settings, which says how to update this PCP. The layout reads it on
 * every page; nothing polls.
 */
export function UpdateNotice({
  available,
}: {
  available: { version: string } | null
}) {
  if (!available) {
    return null
  }

  return (
    <Link
      href="/settings#updates"
      title="A newer PCP is out. Settings says how to update."
      className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Badge variant="warning">
        <CircleArrowUp className="size-3" aria-hidden />v{available.version}{" "}
        available
      </Badge>
    </Link>
  )
}
