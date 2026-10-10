import { TokenOptionField } from "@/components/token-options"

/**
 * The right to propose wrappers (create_wrapper and its kin,
 * lib/core/wrappers/): every one it proposes, and every change, is yours to
 * agree to. The words live in token-options.tsx.
 */
export function ManageWrappersField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <TokenOptionField
      option="manageWrappers"
      id={id}
      defaultChecked={defaultChecked}
    />
  )
}
