import { TokenOptionField } from "@/components/token-options"

/**
 * The right to read and change the API endpoints an assistant set up
 * (get_endpoint, update_endpoint). Registering one is register_server, which
 * any token may ask for and the owner decides; this is about what happens
 * after. The words live in token-options.tsx.
 */
export function ManageEndpointsField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <TokenOptionField
      option="manageEndpoints"
      id={id}
      defaultChecked={defaultChecked}
    />
  )
}
