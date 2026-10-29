import type { CloneInput } from "@/lib/core/definitions"

import { field } from "./action-state"
import { extraHeadersFrom } from "./extra-headers"

/**
 * What a server's own part is, as the clone form and the form that adds a
 * server from a repository send it (components/clone-form.tsx): its name,
 * address, sign-in and the owner's note.
 */
export function instanceInputFrom(formData: FormData): CloneInput {
  const authType = field(formData, "authType")

  return {
    name: field(formData, "name"),
    url: field(formData, "url"),
    note: field(formData, "note"),
    authType:
      authType === "header" || authType === "basic" || authType === "oauth"
        ? authType
        : "none",
    authHeaderName: field(formData, "authHeaderName") || null,
    authValueTemplate: field(formData, "authValueTemplate") || null,
    authSecretId: field(formData, "authSecretId") || null,
    authSecretName: field(formData, "authSecretName") || null,
    authSecretValue: field(formData, "authSecretValue") || null,
    authUsername: field(formData, "authUsername") || null,
    oauthClientId: field(formData, "oauthClientId") || null,
    oauthClientSecretId: field(formData, "oauthClientSecretId") || null,
    oauthClientSecretValue: field(formData, "oauthClientSecretValue") || null,
    oauthScope: field(formData, "oauthScope") || null,
    oauthAuthorizeParams: field(formData, "oauthAuthorizeParams") || null,
    authExtraHeaders: extraHeadersFrom(formData),
  }
}
