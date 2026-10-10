import { TokenOptionField } from "@/components/token-options"

/**
 * The right to keep memories through the gateway's memory tool: notes of
 * its own, and the shared ones you agreed to (lib/core/memories.ts). The
 * words live in token-options.tsx, with the shorter row the assistant's
 * pages use.
 */
export function KeepMemoriesField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <TokenOptionField
      option="keepMemories"
      id={id}
      defaultChecked={defaultChecked}
    />
  )
}
