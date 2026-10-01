import { invalid } from "../errors"

/**
 * The two addresses an API endpoint has: where its schema is read from and
 * where its requests go. Both are the owner's to set; neither may carry a
 * user name or password (those belong in a secret).
 */

function parseHttpUrl(raw: string, help: string): URL {
  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    throw invalid(help)
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid(
      "The address must start with https:// (or http:// on a private network).",
    )
  }

  if (url.username || url.password) {
    throw invalid(
      "The address cannot contain a user name or password; keep credentials in a secret.",
    )
  }

  return url
}

export function validateSpecUrl(raw: string): string {
  if (!raw.trim()) {
    throw invalid("Enter the schema's URL, or upload the file.")
  }

  const url = parseHttpUrl(
    raw,
    "Enter the schema's full address, like https://api.example.com/openapi.json.",
  )
  url.hash = ""
  return url.toString()
}

/** origin + path, without a trailing slash, so operation paths append. */
export function validateBaseUrl(raw: string): string {
  const url = parseHttpUrl(
    raw,
    "Enter the API's base URL, like https://api.example.com/v1.",
  )

  if (url.search || url.hash) {
    throw invalid("The base URL cannot have a query or a fragment.")
  }

  return url.origin + url.pathname.replace(/\/+$/, "")
}
