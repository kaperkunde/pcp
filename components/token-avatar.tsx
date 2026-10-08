import { cn } from "@/lib/utils"

/**
 * An assistant's round tile: the first letter of its token's name, so the
 * list and its page tell assistants apart at a glance. Decorative: the name
 * is always beside it.
 */
export function TokenAvatar({
  name,
  size = "md",
  dimmed = false,
}: {
  name: string
  size?: "md" | "lg"
  dimmed?: boolean
}) {
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?"

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-[#2a2f3a] font-semibold text-foreground",
        size === "lg" ? "size-14 text-[22px]" : "size-[34px] text-sm",
        dimmed && "text-muted-foreground opacity-70",
      )}
    >
      {letter}
    </span>
  )
}
