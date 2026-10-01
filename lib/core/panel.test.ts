import { describe, expect, it } from "vitest"

import { connectResult, panelHtml } from "./panel"

describe("connectResult", () => {
  const server = { id: "s1", slug: "mail", name: "Mail" }
  const said = (result: ReturnType<typeof connectResult>) =>
    (result.content[0] as { text: string }).text

  it("asks the owner to connect a server that needs signing in to", () => {
    const text = said(
      connectResult({ ...server, status: "auth_required" }, "https://pcp.x"),
    )

    expect(text).toMatch(/Mail needs connecting/)
    expect(text).toContain("https://pcp.x/servers/s1")
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
    expect(result.structuredContent).toMatchObject({ kind: "connect" })
  })
})

describe("panelHtml", () => {
  // The script is a string to the compiler: only parsing it finds a typo.
  it("carries a script that parses", () => {
    const html = panelHtml()
    const script = html.slice(
      html.indexOf("<script>") + "<script>".length,
      html.lastIndexOf("</script>"),
    )

    expect(script).toContain("ui/notifications/request-teardown")
    expect(() => new Function(script)).not.toThrow()
  })
})
