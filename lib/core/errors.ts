/**
 * Failures the caller can act on. Server Actions and the gateway turn these
 * into a message for the person or the assistant; anything else is a bug
 * and is logged as one.
 */
export type PcpErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "upstream"
  | "state"

export class PcpError extends Error {
  readonly code: PcpErrorCode

  constructor(code: PcpErrorCode, message: string) {
    super(message)
    this.name = "PcpError"
    this.code = code
  }
}

export function isPcpError(error: unknown): error is PcpError {
  return error instanceof PcpError
}

export function invalid(message: string): PcpError {
  return new PcpError("validation", message)
}

export function notFound(what: string): PcpError {
  return new PcpError("not_found", `${what} was not found.`)
}
