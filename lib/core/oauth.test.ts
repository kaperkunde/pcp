import { describe, expect, it } from "vitest"

import { reconcileIssuer } from "./oauth"

// Regression: in the Docker image (bound to 0.0.0.0) Next.js rewrote the
// first loopback address in the callback URL — which was inside the encoded
// `iss` parameter — to "localhost", and the SDK's RFC 9207 check refused an
// issuer of 127.0.0.1 that came back as localhost.
describe("reconcileIssuer", () => {
  it("accepts another spelling of the same loopback issuer", () => {
    expect(
      reconcileIssuer("http://localhost:38665", "http://127.0.0.1:38665"),
    ).toBe("http://127.0.0.1:38665")
    expect(
      reconcileIssuer("http://localhost:8080/as", "http://[::1]:8080/as"),
    ).toBe("http://[::1]:8080/as")
  })

  it("passes everything else through untouched for the SDK to judge", () => {
    // Same issuer: nothing to reconcile.
    expect(
      reconcileIssuer("https://auth.example.com", "https://auth.example.com"),
    ).toBe("https://auth.example.com")
    // A different host is a mix-up, not a spelling: the SDK must refuse it.
    expect(
      reconcileIssuer("https://evil.example.com", "https://auth.example.com"),
    ).toBe("https://evil.example.com")
    // Loopback but another port or path is another server.
    expect(
      reconcileIssuer("http://localhost:9999", "http://127.0.0.1:38665"),
    ).toBe("http://localhost:9999")
    expect(
      reconcileIssuer("http://localhost:38665/x", "http://127.0.0.1:38665"),
    ).toBe("http://localhost:38665/x")
    // Nothing recorded, nothing received, or garbage: unchanged.
    expect(reconcileIssuer("http://localhost:1", undefined)).toBe(
      "http://localhost:1",
    )
    expect(reconcileIssuer(undefined, "http://127.0.0.1:1")).toBeUndefined()
    expect(reconcileIssuer("not a url", "http://127.0.0.1:1")).toBe("not a url")
  })
})
