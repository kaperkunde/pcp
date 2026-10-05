import { invalid } from "../errors"
import { AddressBlockedError } from "../openapi/address"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { send, type SendOptions } from "../openapi/transport"
import { PCP_VERSION } from "../version"
import { MAIL_CONNECT_TIMEOUT_MS } from "./limits"

/**
 * A look at the JMAP session URL an assistant proposed, before the owner is
 * asked about it, so a wrong address is refused at once and the owner is
 * shown what answered. It sends no credential, reaches public addresses
 * only (the address is the assistant's to name, so it is never PCP's to
 * reach into a network), and follows no redirect: where one pointed is
 * said, for the proposal to be made again with it. A private address is not
 * looked at; that is said too, and the owner decides when they are asked.
 */

const MAIL = "urn:ietf:params:jmap:mail"
const MAX_PROBE_BYTES = 64 * 1024

export type JmapProbe =
  /** What answered, in a sentence for the owner. */
  | { checked: string; privateAddress: null }
  /** Not looked at: the address is private or local. */
  | { checked: null; privateAddress: string }

function where(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

/** The sign-in schemes a 401 offers, as the owner would name them. */
function schemesOf(header: string | null): string[] {
  const found = new Set<string>()

  for (const match of (header ?? "").matchAll(/\b(basic|bearer)\b/gi)) {
    const scheme = match[1]!.toLowerCase()
    found.add(scheme === "basic" ? "Basic" : "Bearer")
  }

  return [...found]
}

export async function probeJmapSession(
  sessionUrl: string,
  {
    timeoutMs = MAIL_CONNECT_TIMEOUT_MS,
    addressCheck,
  }: { timeoutMs?: number } & Pick<SendOptions, "addressCheck"> = {},
): Promise<JmapProbe> {
  const there = where(sessionUrl)
  let response: Response

  try {
    response = await send(
      sessionUrl,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "user-agent": `pcp/${PCP_VERSION}`,
        },
      },
      { publicOnly: true, addressCheck },
    )
  } catch (error) {
    if (error instanceof AddressBlockedError) {
      return {
        checked: null,
        privateAddress: `${error.host} is, or resolves to, a private or local address, so PCP did not look at it from here.`,
      }
    }

    throw invalid(
      `${there} could not be reached: ${describeFetchError(error, timeoutMs)}. Check the address.`,
    )
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    await discard(response)
    const target = location
      ? where(new URL(location, sessionUrl).toString())
      : null

    throw invalid(
      `${there} answered with a redirect${target ? ` to ${target}` : ""}. PCP does not follow redirects: propose that address instead.`,
    )
  }

  if (response.status === 401) {
    const schemes = schemesOf(response.headers.get("www-authenticate"))
    await discard(response)

    return {
      checked: `A server answers at ${there} and asks for a sign-in${schemes.length > 0 ? ` (${schemes.join(" or ")})` : ""}.`,
      privateAddress: null,
    }
  }

  if (response.status < 200 || response.status >= 300) {
    await discard(response)

    throw invalid(
      `${there} answered HTTP ${response.status}. The session URL is usually https://<server>/.well-known/jmap.`,
    )
  }

  let capabilities: unknown

  try {
    const { bytes } = await readCapped(response, MAX_PROBE_BYTES)
    capabilities = (
      JSON.parse(bytes.toString("utf8")) as { capabilities?: unknown }
    ).capabilities
  } catch {
    capabilities = undefined
  }

  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    !(MAIL in capabilities)
  ) {
    throw invalid(
      `${there} answered, but not with a JMAP session for mail. The session URL is usually https://<server>/.well-known/jmap.`,
    )
  }

  return {
    checked: `A JMAP server answers at ${there}.`,
    privateAddress: null,
  }
}
