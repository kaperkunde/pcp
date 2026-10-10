import { TokenOptionField } from "@/components/token-options"

/**
 * The right to fetch web pages through the gateway's web_fetch tool, as the
 * token's site and method levels say (lib/core/web-fetch.ts). The words
 * live in token-options.tsx.
 */
export function WebFetchField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <TokenOptionField
      option="webFetch"
      id={id}
      defaultChecked={defaultChecked}
    />
  )
}
