import { describe, expect, it } from "vitest"

import { scriptReaches } from "../browser-scripts"
import {
  admitConnection,
  isServiceWorkerScript,
  type ScriptRun,
  type VaultBrowser,
} from "./runtime"

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

describe("connections while a script runs", () => {
  function running(site: string, extras: string[] = []) {
    const kept = new Set(extras)
    let finish = () => {}
    const run: ScriptRun = {
      site,
      reaches: (host) => scriptReaches(site, host, kept),
      refused: new Set(),
      listeners: new Set(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
    }
    const vault = {
      tabs: new Map([["t1", { script: run }]]),
    } as unknown as VaultBrowser

    return { vault, run, finish }
  }

  it("lets through its own domain and what the owner allowed, holds the rest", async () => {
    const { vault, run, finish } = running("bestellen.dominos.nl", [
      "cdn.example.net",
    ])

    expect(await admitConnection(vault, "olo-graph.dominos.nl")).toBe(true)
    expect(await admitConnection(vault, "cdn.example.net")).toBe(true)

    const held = admitConnection(vault, "evil.test")
    expect(held).toBeInstanceOf(Promise)
    run.refused.add("evil.test")
    for (const listener of run.listeners) listener()
    expect(await held).toBe(false)
    finish()
  })

  it("lets an allowed host through for the one site only", async () => {
    const other = running("other.example", [])

    const held = admitConnection(other.vault, "cdn.example.net")
    expect(held).toBeInstanceOf(Promise)
    other.run.refused.add("cdn.example.net")
    for (const listener of other.run.listeners) listener()
    expect(await held).toBe(false)
    other.finish()
  })
})
