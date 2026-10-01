import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * The right to keep memories through the gateway's memory tool: notes of
 * its own, and the shared ones you agreed to (lib/core/memories.ts).
 */
export function KeepMemoriesField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-normal" htmlFor={id}>
        <Checkbox id={id} name="keepMemories" defaultChecked={defaultChecked} />
        Let an assistant with this token keep memories
      </Label>
      <p className="text-xs text-muted-foreground">
        It can keep notes for itself between conversations, and read the
        memories you share with all your assistants. To share one of its own, or
        change a shared one, it has to ask you, and you see the whole text
        first. You can read, edit and delete every memory under Memories.
      </p>
    </div>
  )
}
