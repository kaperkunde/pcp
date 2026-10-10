/**
 * Lifetimes and size limits of PCP's authorization server. A code and an
 * access token each carry a copy of the vault's key, so they live briefly;
 * a refresh token is replaced at every use.
 */

/** An authorization code: the client exchanges it at once. */
export const CODE_TTL_MS = 2 * 60 * 1000
/** An access token, as `expires_in` says. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
/** A refresh token, from when it was issued; each use issues a new one. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** A client's redirect URIs, and any URI it names. */
export const MAX_REDIRECT_URIS = 10
export const MAX_URI_LENGTH = 2000
/** A client's name, as the owner sees it (and a new token's name). */
export const MAX_CLIENT_NAME_LENGTH = 80
/** `state`, `scope` and the PKCE values a client sends. */
export const MAX_PARAM_LENGTH = 1000

/** A registration's JSON body. */
export const MAX_REGISTRATION_BYTES = 16 * 1024
/** Registrations no sign-in has used yet, and how long one waits for it. */
export const MAX_UNUSED_REGISTRATIONS = 200
export const UNUSED_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000

/** A client's metadata document (the draft recommends 5 KB). */
export const MAX_METADATA_DOCUMENT_BYTES = 5 * 1024
export const METADATA_DOCUMENT_TIMEOUT_MS = 5_000
