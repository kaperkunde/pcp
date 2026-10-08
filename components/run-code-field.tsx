import { TokenOptionField } from "@/components/token-options"

/**
 * The right to run programs through the gateway's run_code tool, whose
 * calls follow the token's tool levels (lib/core/code/). The words live in
 * token-options.tsx.
 */
export function RunCodeField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <TokenOptionField
      option="runCode"
      id={id}
      defaultChecked={defaultChecked}
    />
  )
}
