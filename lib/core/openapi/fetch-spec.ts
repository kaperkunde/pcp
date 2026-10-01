import { MAX_SPEC_BYTES } from "../constants"
import { invalid } from "../errors"
import { describeFetchError, discard, readCapped } from "./http"
import { SPEC_FETCH_TIMEOUT_MS, SPEC_MAX_REDIRECTS, USER_AGENT } from "./limits"
import { validateSpecUrl } from "./urls"

/**
 * Downloads a schema. It never carries a credential: the endpoint's secret
 * is for the API, and a schema is often hosted somewhere else. Redirects
 * are followed by hand, a few at most, each hop checked like the first.
 */
export async function fetchSpec(
  rawUrl: string,
  { timeoutMs = SPEC_FETCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ text: string; url: string }> {
  let url = validateSpecUrl(rawUrl)
  const signal = AbortSignal.timeout(timeoutMs)

  for (let hop = 0; ; hop++) {
    let response: Response

    try {
      response = await fetch(url, {
        redirect: "manual",
        cache: "no-store",
        signal,
        headers: {
          accept:
            "application/json, application/yaml, application/x-yaml, text/yaml, text/plain;q=0.9, */*;q=0.8",
          "user-agent": USER_AGENT,
        },
      })
    } catch (error) {
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
    if (declared > MAX_SPEC_BYTES) {
      await discard(response)
      throw tooLarge()
    }

    let read: { bytes: Buffer; truncated: boolean }

    try {
      read = await readCapped(response, MAX_SPEC_BYTES)
    } catch (error) {
      throw invalid(
        `The schema could not be downloaded: ${describeFetchError(error, timeoutMs)}.`,
      )
    }

    if (read.truncated) {
      throw tooLarge()
    }

    return { text: new TextDecoder().decode(read.bytes), url }
  }
}

function tooLarge() {
  return invalid(
    `That schema is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB.`,
  )
}
