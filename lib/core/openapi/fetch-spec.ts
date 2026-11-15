import { invalid } from "../errors"
import { AddressBlockedError } from "./address"
import { loadResourceLimits } from "../resources/state"
import { specTooLarge } from "./parse"
import { describeFetchError, discard, readCapped } from "./http"
import { SPEC_FETCH_TIMEOUT_MS, SPEC_MAX_REDIRECTS, USER_AGENT } from "./limits"
import { send, type SendOptions } from "./transport"
import { validateSpecUrl } from "./urls"

/**
 * Downloads a schema. It never carries a credential: the endpoint's secret
 * is for the API, and a schema is often hosted somewhere else. Redirects
 * are followed by hand, a few at most, each hop checked like the first.
 */
export async function fetchSpec(
  rawUrl: string,
  {
    timeoutMs = SPEC_FETCH_TIMEOUT_MS,
    publicOnly = false,
    addressCheck,
    dial,
  }: { timeoutMs?: number } & SendOptions = {},
): Promise<{ text: string; url: string }> {
  const maxBytes = (await loadResourceLimits()).specBytes
  let url = validateSpecUrl(rawUrl)
  const signal = AbortSignal.timeout(timeoutMs)

  for (let hop = 0; ; hop++) {
    let response: Response

    try {
      response = await send(
        url,
        {
          signal,
          headers: {
            accept:
              "application/json, application/yaml, application/x-yaml, text/yaml, text/plain;q=0.9, */*;q=0.8",
            "user-agent": USER_AGENT,
          },
        },
        { publicOnly, addressCheck, dial },
      )
    } catch (error) {
      if (error instanceof AddressBlockedError) {
        throw invalid(error.message)
      }

      throw invalid(
        `The schema could not be downloaded: ${describeFetchError(error, timeoutMs)}.`,
      )
    }

    if (response.status >= 300 && response.status < 400) {
      await discard(response)
      const location = response.headers.get("location")

      if (!location || hop >= SPEC_MAX_REDIRECTS) {
        throw invalid(
          "The schema address redirects too often; enter the final address.",
        )
      }

      url = validateSpecUrl(new URL(location, url).toString())
      continue
    }

    if (!response.ok) {
      await discard(response)
      throw invalid(`The schema address answered HTTP ${response.status}.`)
    }

    const declared = Number(response.headers.get("content-length") ?? "0")
    if (declared > maxBytes) {
      await discard(response)
      throw specTooLarge()
    }

    let read: { bytes: Buffer; truncated: boolean }

    try {
      read = await readCapped(response, maxBytes)
    } catch (error) {
      throw invalid(
        `The schema could not be downloaded: ${describeFetchError(error, timeoutMs)}.`,
      )
    }

    if (read.truncated) {
      throw specTooLarge()
    }

    return { text: new TextDecoder().decode(read.bytes), url }
  }
}
