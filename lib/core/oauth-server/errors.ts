/**
 * An error the authorization server answers with, as RFC 6749 §5.2 (and
 * RFC 7591 §3.2.2 for registration) names them. `status` is the HTTP
 * status of the answer.
 */
export class OAuthError extends Error {
  readonly error: string
  readonly status: number

  constructor(error: string, description: string, status = 400) {
    super(description)
    this.name = "OAuthError"
    this.error = error
    this.status = status
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.error, error_description: this.message }
  }
}

export function invalidRequest(description: string): OAuthError {
  return new OAuthError("invalid_request", description)
}

export function invalidGrant(description: string): OAuthError {
  return new OAuthError("invalid_grant", description)
}

export function invalidClient(description: string): OAuthError {
  return new OAuthError("invalid_client", description, 401)
}
