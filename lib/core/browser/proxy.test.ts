import http from "node:http"
import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import { startTestApi, type TestApi } from "../openapi/test-api"
import {
  startBrowserProxy,
  type AddressVerdict,
  type BrowserProxy,
} from "./proxy"

// The browser's proxy decides every connection by the address PCP resolved,
// and dials that address: here against a local server, with the check
// saying yes or no.

let api: TestApi | null = null
let proxy: BrowserProxy | null = null

afterEach(async () => {
  await proxy?.close()
  await api?.close()
  proxy = null
  api = null
})

function viaProxy(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxy!.port,
      method: "GET",
      path: target,
      headers: { host: new URL(target).host },
    })
    request.on("response", (res) => {
      let body = ""
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    request.on("error", reject)
    request.end()
  })
}

function tunnel(authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy!.port, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      )
    })
    let answer = ""
    socket.on("data", (chunk) => {
      answer += chunk.toString()
      if (answer.includes("\r\n\r\n")) {
        socket.destroy()
        resolve(answer.split("\r\n")[0]!)
      }
    })
    socket.on("error", reject)
  })
}

describe("the browser's proxy", () => {
  it("passes a plain request to an address the check allows", async () => {
    api = await startTestApi((_, res) => res.end("hello from the page"))
    const seen: Array<[string, number]> = []
    proxy = await startBrowserProxy({
      check: (address, port) => {
        seen.push([address, port])
        return "ok"
      },
    })

    const answer = await viaProxy(`${api.origin}/page`)

    expect(answer).toEqual({ status: 200, body: "hello from the page" })
    expect(seen).toEqual([["127.0.0.1", Number(new URL(api.origin).port)]])
    expect(api.requests[0]!.url).toBe("/page")
  })

  it("tells the check which name the browser asked for", async () => {
    api = await startTestApi((_, res) => res.end("hello"))
    const port = new URL(api.origin).port
    const names: string[] = []
    // Refused, so nothing is dialed: only the names are of interest here.
    proxy = await startBrowserProxy({
      check: (_address, _port, host) => {
        names.push(host)
        return "private"
      },
    })

    expect((await viaProxy(`http://LocalHost:${port}/page`)).status).toBe(403)
    expect(await tunnel(`[::1]:${port}`)).toBe("HTTP/1.1 403 Forbidden")

    expect(names[0]).toBe("localhost")
    expect(names.at(-1)).toBe("::1")
    expect(api.requests).toHaveLength(0)
  })

  it("refuses, before connecting, what the check refuses, and remembers why", async () => {
    api = await startTestApi((_, res) => res.end("secret"))
    const verdict: AddressVerdict = "private"
    proxy = await startBrowserProxy({ check: () => verdict })

    expect((await viaProxy(`${api.origin}/admin`)).status).toBe(403)
    expect(await tunnel(new URL(api.origin).host)).toMatch(/^HTTP\/1\.1 403/)
    expect(api.requests).toHaveLength(0)
    expect(proxy.refusal("127.0.0.1")).toBe("private")
    expect(proxy.refusal("example.com")).toBeNull()
  })

  it("checks every address a name resolves to", async () => {
    api = await startTestApi((_, res) => res.end("secret"))
    const port = new URL(api.origin).port
    proxy = await startBrowserProxy({
      check: (address) => (address === "127.0.0.1" ? "ok" : "own"),
    })

    // localhost may also be ::1, which this check refuses: then nothing goes.
    const answer = await tunnel(`localhost:${port}`)
    expect(answer).toMatch(/^HTTP\/1\.1 (200|403)/)

    if (answer.includes("403")) {
      expect(proxy.refusal("localhost")).toBe("own")
    }
  })

  it("opens a tunnel to an allowed address", async () => {
    api = await startTestApi((_, res) => res.end("ok"))
    proxy = await startBrowserProxy({ check: () => "ok" })

    expect(await tunnel(new URL(api.origin).host)).toBe(
      "HTTP/1.1 200 Connection Established",
    )
  })

  it("refuses a tunnel to something that is not host:port", async () => {
    proxy = await startBrowserProxy({ check: () => "ok" })
    expect(await tunnel("user:pass@example.com:443")).toMatch(/^HTTP\/1\.1 400/)
  })
})
