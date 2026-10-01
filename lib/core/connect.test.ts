import { describe, expect, it } from "vitest"

import { connectResult, isConnectResult } from "./connect"

describe("connectResult", () => {
  const server = { id: "s1", slug: "mail", name: "Mail" }
  const said = (result: ReturnType<typeof connectResult>) =>
    (result.content[0] as { text: string }).text

  it("hands over the server's page to connect it, and check_server to wait", () => {
    const result = connectResult(
      { ...server, status: "auth_required" },
      "https://pcp.x/",
    )

    expect(said(result)).toMatch(/Mail needs connecting/)
    expect(said(result)).toContain(
      "Give the owner this link, to open signed in to PCP and choose Connect: https://pcp.x/servers/s1",
    )
    expect(said(result)).toContain(
      'call check_server with server "mail": it waits while they do',
    )
    expect(result.structuredContent).toMatchObject({
      kind: "connect",
      connect: { startUrl: "https://pcp.x/api/servers/s1/oauth/start" },
    })
    expect(isConnectResult(result)).toBe(true)
  })

  it("says the owner must add a client when the server lets no app register", () => {
    const result = connectResult(
      { ...server, status: "client_required" },
      "https://pcp.x",
    )

    expect(said(result)).toMatch(
      /Mail needs an OAuth client from the owner before it can be connected/,
    )
    expect(said(result)).toContain("https://pcp.x/servers/s1")
  })

  it("tells a connect result from any other", () => {
    expect(isConnectResult({ content: [] })).toBe(false)
    expect(
      isConnectResult({ content: [], structuredContent: { kind: "done" } }),
    ).toBe(false)
  })
})
