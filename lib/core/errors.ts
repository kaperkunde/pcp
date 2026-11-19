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

/**
 * A kept result that holds a part an assistant named in keep (#149), asked
 * to be read out: PCP only puts it in a tool's arguments. Refused as
 * "forbidden"; the tool error carries the code "pass_only"
 * (tools/outcome.ts).
 */
export class PassOnlyError extends PcpError {
  constructor(id: string) {
    super("forbidden", passOnlyMessage(id))
    this.name = "PassOnlyError"
  }
}

/** Why a pass-only result is not read out, in the assistant's words. */
export function passOnlyMessage(id: string): string {
  return `This result holds a part keep named; PCP puts it in a tool's arguments as {"$result": "${id}"} and never reads it out.`
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
