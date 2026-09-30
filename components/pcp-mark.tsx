import Image from "next/image"

import { cn } from "@/lib/utils"

/**
 * The logo, next to the "PCP" wordmark in the dashboard header and on the
 * sign-in pages. Decorative: the wordmark beside it is the accessible name.
 * Cut from assets/icon.png at 3x; served as a plain file, not through the
 * image optimizer.
 */
export function PcpMark({ className }: { className?: string }) {
  return (
    <Image
      src="/icons/mark.png"
      alt=""
      width={32}
      height={32}
      unoptimized
      priority
      className={cn("size-8 shrink-0", className)}
    />
  )
}
