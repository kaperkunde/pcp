import { SwitchRow } from "@/components/ui/switch"
import { MAX_SHARED_MEMORY_CHARS } from "@/lib/core/constants"

/**
 * Whether a memory is read in every conversation: a switch row for a form
 * (it submits as `always`), on the Memories page when the owner writes or
 * edits one.
 */
export function MemoryAlwaysSwitch({
  id,
  defaultChecked,
}: {
  id: string
  defaultChecked: boolean
}) {
  return (
    <SwitchRow
      id={id}
      name="always"
      label="Read in every conversation"
      description={`It comes with PCP's instructions, so an assistant has it before it does anything, without having to look. Up to ${MAX_SHARED_MEMORY_CHARS.toLocaleString("en")} characters. If an assistant changes one it keeps for itself, it stops being read in every conversation until you switch this on again.`}
      defaultChecked={defaultChecked}
    />
  )
}
