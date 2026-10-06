import { describe, expect, it } from "vitest"

import { clientHello, clientSeen } from "./client-hello"

const initialize = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {}, url: {} }, roots: {} },
    clientInfo: { name: "claude-ai", version: "0.1.0" },
  },
}

describe("clientHello", () => {
  it("reads the client's name, version, capabilities and user agent", () => {
    const hello = clientHello(
      JSON.stringify(initialize),
      new Headers({
        "User-Agent": "Claude-User",
        Authorization: "Bearer pcp_secret",
        "Mcp-Protocol-Version": "2025-11-25",
      }),
    )

    expect(hello).toEqual({
      client: { name: "claude-ai", title: undefined, version: "0.1.0" },
      protocolVersion: "2025-11-25",
      capabilities: { elicitation: ["form", "url"], roots: [] },
      userAgent: "Claude-User",
      headers: ["authorization", "mcp-protocol-version", "user-agent"],
    })
  })

  it("never keeps a header's value but the user agent's", () => {
    const hello = clientHello(
      JSON.stringify(initialize),
      new Headers({ Authorization: "Bearer pcp_secret" }),
    )

    expect(JSON.stringify(hello)).not.toContain("pcp_secret")
  })

  it("is null for anything but initialize", () => {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }

    expect(clientHello(JSON.stringify(call), new Headers())).toBeNull()
    expect(clientHello("not json", new Headers())).toBeNull()
    expect(clientHello("null", new Headers())).toBeNull()
  })

  it("cuts what a client chooses to send", () => {
    const hello = clientHello(
      JSON.stringify({
        ...initialize,
        params: {
          clientInfo: { name: "x".repeat(10_000) },
          capabilities: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [`c${i}`, {}]),
          ),
        },
      }),
      new Headers(),
    )

    expect(hello?.client.name).toHaveLength(200)
    expect(Object.keys(hello?.capabilities ?? {})).toHaveLength(40)
  })
})

describe("clientSeen", () => {
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" })

  it("describes a token's client the first time only", () => {
    const headers = new Headers({
      "User-Agent": "Claude-User",
      Authorization: "Bearer pcp_secret",
    })

    expect(clientSeen("token-a", call, headers)).toEqual({
      method: "tools/call",
      userAgent: "Claude-User",
      headers: ["authorization", "user-agent"],
    })
    expect(clientSeen("token-a", call, headers)).toBeNull()
    expect(clientSeen("token-b", call, headers)).not.toBeNull()
  })

  it("sees a new user agent or header set as a new client", () => {
    const first = new Headers({ "User-Agent": "one" })

    expect(clientSeen("token-c", call, first)).not.toBeNull()
    expect(
      clientSeen("token-c", call, new Headers({ "User-Agent": "two" })),
    ).not.toBeNull()
    expect(
      clientSeen(
        "token-c",
        call,
        new Headers({ "User-Agent": "one", "X-Extra": "1" }),
      ),
    ).not.toBeNull()
  })

  it("never keeps a header's value but the user agent's", () => {
    const seen = clientSeen(
      "token-d",
      "not json",
      new Headers({ Authorization: "Bearer pcp_secret" }),
    )

    expect(JSON.stringify(seen)).not.toContain("pcp_secret")
    expect(seen?.method).toBeUndefined()
  })
})
