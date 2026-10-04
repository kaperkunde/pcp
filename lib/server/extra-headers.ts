import type { ExtraAuthHeaderInput } from "@/lib/core/servers"

import { fields } from "./action-state"

/**
 * The further secret headers a server or endpoint form sends, as repeated
 * fields in the order they were shown (components/header-auth-fields.tsx).
 */
export function extraHeadersFrom(formData: FormData): ExtraAuthHeaderInput[] {
  const secretIds = fields(formData, "authExtraSecretId")
  const headerNames = fields(formData, "authExtraHeaderName")
  const templates = fields(formData, "authExtraValueTemplate")

  return secretIds.map((secretId, index) => ({
    secretId: secretId || null,
    headerName: headerNames[index] ?? "",
    valueTemplate: templates[index] ?? "",
  }))
}
