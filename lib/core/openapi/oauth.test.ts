import { describe, expect, it } from "vitest"

import { readOAuth } from "./oauth"

const google = {
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "query", name: "key" },
      Oauth2: {
        type: "oauth2",
        flows: {
          implicit: {
            authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
            scopes: {},
          },
          authorizationCode: {
            authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token",
            scopes: {
              "https://mail.google.com/": "Everything",
              "https://www.googleapis.com/auth/gmail.readonly": "Read",
            },
          },
        },
      },
    },
  },
}

describe("readOAuth", () => {
  it("reads the authorization code flow and the scopes offered operations need", () => {
    const { flow, problem } = readOAuth(google, [
      [{ Oauth2: ["https://www.googleapis.com/auth/gmail.readonly"] }],
      [{ Oauth2: ["https://www.googleapis.com/auth/gmail.readonly"] }],
    ])

    expect(problem).toBeNull()
    expect(flow).toEqual({
      scheme: "Oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    })
  })

  it("asks for every scope the flow lists when no operation names one", () => {
    expect(readOAuth(google, [undefined]).flow?.scopes).toEqual([
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.readonly",
    ])
  })

  it("says why a schema's OAuth cannot be used", () => {
    expect(readOAuth({ components: {} }, [])).toEqual({
      flow: null,
      problem: null,
    })
    expect(
      readOAuth(
        {
          components: {
            securitySchemes: {
              o: {
                type: "oauth2",
                flows: { clientCredentials: { tokenUrl: "https://a/t" } },
              },
            },
          },
        },
        [],
      ).problem,
    ).toMatch(/no authorization code flow/)
    expect(
      readOAuth(
        {
          components: {
            securitySchemes: {
              o: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: "/authorize",
                    tokenUrl: "https://a.example/token",
                  },
                },
              },
            },
          },
        },
        [],
      ).problem,
    ).toMatch(/full http\(s\) authorizationUrl/)
    expect(
      readOAuth(
        {
          components: {
            securitySchemes: {
              oidc: {
                type: "openIdConnect",
                openIdConnectUrl: "https://a/.well-known/openid-configuration",
              },
            },
          },
        },
        [[{ oidc: [] }]],
      ).problem,
    ).toMatch(/OpenID Connect discovery/)
  })

  it("skips scopes no server would take", () => {
    const flow = readOAuth(
      {
        components: {
          securitySchemes: {
            o: {
              type: "oauth2",
              flows: {
                authorizationCode: {
                  authorizationUrl: "https://a.example/authorize",
                  tokenUrl: "https://a.example/token",
                },
              },
            },
          },
        },
      },
      [[{ o: ["read", "two words", 'quo"te', "x".repeat(300), "write"] }]],
    ).flow

    expect(flow?.scopes).toEqual(["read", "write"])
  })
})
