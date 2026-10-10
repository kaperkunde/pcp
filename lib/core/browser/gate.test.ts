import { describe, expect, it } from "vitest"

import { isServiceWorkerScript } from "./runtime"

// The gate refuses a service worker's script itself: the request a browser
// makes to register one is marked "Service-Worker: script".

describe("telling a service worker's script", () => {
  it("is the request marked as one, in whatever case the protocol hands the header", () => {
    expect(isServiceWorkerScript({ "Service-Worker": "script" })).toBe(true)
    expect(isServiceWorkerScript({ "service-worker": "script" })).toBe(true)
    expect(isServiceWorkerScript({ "SERVICE-WORKER": " Script " })).toBe(true)
  })

  it("is no other request", () => {
    expect(isServiceWorkerScript(undefined)).toBe(false)
    expect(isServiceWorkerScript({})).toBe(false)
    expect(isServiceWorkerScript({ Accept: "*/*" })).toBe(false)
    expect(isServiceWorkerScript({ "Service-Worker": "other" })).toBe(false)
    expect(isServiceWorkerScript({ "X-Service-Worker": "script" })).toBe(false)
  })
})
