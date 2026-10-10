import { cn } from "@/lib/utils"

/**
 * One of a few choices as a card with a radio dot, for a sheet where the
 * choice is the point (which app, what it reaches). A native radio inside a
 * label: the arrow keys move between cards of one `name`.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onChoose,
  title,
  caption,
}: {
  name: string
  value: string
  checked: boolean
  onChoose: () => void
  title: string
  caption: string
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border border-separator bg-field p-3.5 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
        checked &&
          "border-primary bg-primary/10 shadow-[inset_0_0_0_1px_var(--color-primary)]",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChoose}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "size-[18px] shrink-0 rounded-full border-2 border-muted-foreground/60",
          checked && "border-[5px] border-primary",
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </span>
    </label>
  )
}
