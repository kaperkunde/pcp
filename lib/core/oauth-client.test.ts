import { describe, expect, it } from "vitest"

import {
  applyAuthorizeParams,
  chooseRegistration,
  clientMetadataDocument,
  clientMetadataUrl,
  normalizeAuthorizeParams,
  oauthRedirectUrl,
  tokenLifetime,
} from "./oauth-client"

const HTTPS = "https://pcp.example.com"

describe("chooseRegistration", () => {
  const base = {
    clientId: null,
    storedClient: false,
    metadata: { registration_endpoint: "https://as.example.com/register" },
    metadataUrl: clientMetadataUrl(HTTPS),
  }

  it("uses the owner's client before anything else", () => {
    expect(chooseRegistration({ ...base, clientId: "abc" })).toBe(
      "preregistered",
    )
    expect(
      chooseRegistration({ ...base, clientId: "abc", storedClient: true }),
    ).toBe("preregistered")
  })

  it("keeps a client PCP registered earlier", () => {
    expect(
      chooseRegistration({ ...base, storedClient: true, metadata: {} }),
    ).toBe("stored")
  })

  it("registers dynamically when the server allows it, or says nothing", () => {
    expect(chooseRegistration(base)).toBe("dynamic")
    expect(
      chooseRegistration({
        ...base,
        metadata: {
          registration_endpoint: "https://as.example.com/register",
          client_id_metadata_document_supported: true,
        },
      }),
    ).toBe("dynamic")
    expect(chooseRegistration({ ...base, metadata: undefined })).toBe("dynamic")
  })

  it("offers its metadata document only when the server takes one and PCP is on https", () => {
    const cimd = { client_id_metadata_document_supported: true }

    expect(chooseRegistration({ ...base, metadata: cimd })).toBe(
      "metadata-document",
    )
    expect(
      chooseRegistration({
        ...base,
        metadata: cimd,
        metadataUrl: clientMetadataUrl("http://pcp.lan:3000"),
      }),
    ).toBe("needs-client")
  })

  it("asks the owner for a client when nothing else works", () => {
    expect(chooseRegistration({ ...base, metadata: {} })).toBe("needs-client")
    expect(
      chooseRegistration({
        ...base,
        metadata: { client_id_metadata_document_supported: false },
      }),
    ).toBe("needs-client")
  })
})

describe("the client metadata document", () => {
  it("is served at the address it names as its client ID, with the one redirect", () => {
    const document = clientMetadataDocument(`${HTTPS}/`, "1.2.3")

    expect(document).toMatchObject({
      client_id: `${HTTPS}/api/oauth/client-metadata`,
      client_name: "PCP",
      redirect_uris: [`${HTTPS}/api/oauth/callback`],
      token_endpoint_auth_method: "none",
      software_version: "1.2.3",
    })
    expect(oauthRedirectUrl(`${HTTPS}/`)).toBe(`${HTTPS}/api/oauth/callback`)
  })

  it("does not exist off https", () => {
    expect(clientMetadataUrl("http://localhost:3000")).toBeNull()
    expect(clientMetadataDocument("http://localhost:3000", "1")).toBeNull()
  })
})

describe("normalizeAuthorizeParams", () => {
  it("accepts a query string or one parameter per line", () => {
    expect(normalizeAuthorizeParams("access_type=offline&prompt=consent")).toBe(
      "access_type=offline&prompt=consent",
    )
    expect(
      normalizeAuthorizeParams(
        " access_type=offline \n prompt=select_account ",
      ),
    ).toBe("access_type=offline&prompt=select_account")
    expect(normalizeAuthorizeParams("audience=https%3A%2F%2Fapi.x.com")).toBe(
      "audience=https%3A%2F%2Fapi.x.com",
    )
  })

  it("is null when empty", () => {
    expect(normalizeAuthorizeParams("")).toBeNull()
    expect(normalizeAuthorizeParams("  \n ")).toBeNull()
    expect(normalizeAuthorizeParams(null)).toBeNull()
  })

  it("refuses what the flow sets itself", () => {
    for (const name of [
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "response_type",
      "resource",
      "Redirect_URI",
    ]) {
      expect(() => normalizeAuthorizeParams(`${name}=x`)).toThrow(/itself/)
    }
    expect(() => normalizeAuthorizeParams("scope=email")).toThrow(/Scope field/)
  })

  it("refuses malformed names, empty or oversized values, and repeats", () => {
    expect(() => normalizeAuthorizeParams("bad name=x")).toThrow(
      /parameter name/,
    )
    expect(() => normalizeAuthorizeParams("prompt")).toThrow(/value/)
    expect(() => normalizeAuthorizeParams(`x=${"a".repeat(501)}`)).toThrow(
      /too long/,
    )
    expect(() => normalizeAuthorizeParams("x=a%0Ay")).toThrow(/control/)
    expect(() => normalizeAuthorizeParams("x=1&x=2")).toThrow(/twice/)
    expect(() => normalizeAuthorizeParams("x=%E0%A4%A")).toThrow(/encoded/)
    expect(() =>
      normalizeAuthorizeParams(
        Array.from({ length: 11 }, (_, n) => `p${n}=1`).join("&"),
      ),
    ).toThrow(/10 parameters/)
    expect(() => normalizeAuthorizeParams("x=1&".repeat(2000))).toThrow(
      /too long/,
    )
  })
})

describe("applyAuthorizeParams", () => {
  it("adds parameters without touching what the flow set", () => {
    const url = new URL(
      "https://as.example.com/authorize?client_id=pcp&prompt=consent&state=s",
    )

    applyAuthorizeParams(url, "access_type=offline&prompt=none")

    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("client_id")).toBe("pcp")
  })

  it("never adds a reserved name, even from a stored value", () => {
    const url = new URL("https://as.example.com/authorize?state=s")

    applyAuthorizeParams(url, "redirect_uri=https%3A%2F%2Fevil.example&x=1")

    expect(url.searchParams.has("redirect_uri")).toBe(false)
    expect(url.searchParams.get("x")).toBe("1")
  })
})

describe("tokenLifetime", () => {
  it("says whether PCP can renew access, and when it runs out", () => {
    expect(
      tokenLifetime(
        { refresh_token: "r", expires_in: 3600 },
        "2026-01-01T00:00:00.000Z",
      ),
    ).toEqual({
      renewable: true,
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    })
    expect(tokenLifetime({}, undefined)).toEqual({
      renewable: false,
      expiresAt: null,
    })
  })
})
