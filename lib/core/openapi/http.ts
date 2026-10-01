/**
 * Small fetch helpers shared by the schema download and API calls: a body
 * reader that stops at a byte limit, and a readable reason for a failure.
 */

export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) {
    return { bytes: Buffer.alloc(0), truncated: false }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      return { bytes: Buffer.concat(chunks), truncated: false }
    }

    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size))
      await reader.cancel().catch(() => {})
      return { bytes: Buffer.concat(chunks), truncated: true }
    }

    chunks.push(value)
    size += value.byteLength
  }
}

export function describeFetchError(error: unknown, timeoutMs: number): string {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return `no answer within ${Math.round(timeoutMs / 1000)} seconds`
  }

  const cause = error instanceof Error ? (error.cause as unknown) : undefined
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : ""
  const message = error instanceof Error ? error.message : String(error)

  return (code || message).slice(0, 200)
}

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}
