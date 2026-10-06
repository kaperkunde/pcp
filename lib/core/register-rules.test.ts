import { describe, expect, it } from "vitest"

import {
  checkRegisterShape,
  resolveKind,
  type RegisterKind,
  type RegisterShape,
} from "./register-rules"

describe("resolveKind", () => {
  it("is what was named", () => {
    expect(resolveKind({ kind: "jmap" })).toBe("jmap")
    expect(resolveKind({ kind: "imap", openapi_url: "https://x" })).toBe("imap")
  })

  it("is an API when an OpenAPI document comes with it, and an MCP server otherwise", () => {
    expect(resolveKind({ openapi_schema: "{}" })).toBe("api")
    expect(resolveKind({ openapi_url: "https://example.com/o.json" })).toBe(
      "api",
    )
    expect(resolveKind({})).toBe("mcp")
  })
})

describe("checkRegisterShape", () => {
  const check = (kind: RegisterKind, args: RegisterShape) =>
    checkRegisterShape(kind, args)

  const mcp = { url: "https://mcp.example.com/mcp" }
  const api = { openapi_schema: "{}" }
  const jmap = { url: "https://mail.example.com" }
  const imap = { url: "mail.example.com" }

  describe("what has always been accepted still is", () => {
    it("takes an MCP server, bare or with a header secret or OAuth", () => {
      expect(check("mcp", mcp)).toBeNull()
      expect(
        check("mcp", { ...mcp, auth_type: "header", secret: "Linear key" }),
      ).toBeNull()
      expect(check("mcp", { ...mcp, auth_type: "oauth" })).toBeNull()
      expect(
        check("mcp", {
          ...mcp,
          auth_type: "oauth",
          client_id: "id",
          secret: "client secret",
          oauth_scope: "read",
        }),
      ).toBeNull()
    })

    it("takes an API with a document or an address, read-only, patched, with headers", () => {
      expect(check("api", api)).toBeNull()
      expect(
        check("api", { openapi_url: "https://example.com/o.json" }),
      ).toBeNull()
      expect(
        check("api", {
          ...api,
          read_only: true,
          spec_patches: [],
          url: "https://api.example.com",
          auth_type: "header",
          secret: "Pets key",
          extra_headers: [{ secret: "Pets secret", header_name: "X-Secret" }],
        }),
      ).toBeNull()
    })
  })

  describe("the kind and what it is made from", () => {
    it("wants an address for an MCP server, and says where a mailbox goes", () => {
      expect(check("mcp", {})).toMatch(
        /needs its address in url.*kind jmap or imap/,
      )
      expect(check("mcp", { url: "  " })).toMatch(/needs its address/)
    })

    it("wants a document for an API", () => {
      expect(check("api", { url: "https://api.example.com" })).toMatch(
        /pass it in openapi_schema, or its address in openapi_url/,
      )
    })

    it("keeps an OpenAPI document and its edits from every other kind", () => {
      for (const kind of ["mcp", "jmap", "imap"] as const) {
        const base = kind === "mcp" ? mcp : kind === "jmap" ? jmap : imap
        const auth =
          kind === "mcp"
            ? {}
            : { auth_type: "basic" as const, username: "ada", secret: "pw" }

        for (const extra of [
          { openapi_schema: "{}" },
          { openapi_url: "https://example.com/o.json" },
          { spec_patches: [] },
        ]) {
          expect(check(kind, { ...base, ...auth, ...extra })).toMatch(
            /are for kind api/,
          )
        }
      }
    })

    it("wants a server address for each kind of mail account", () => {
      expect(check("jmap", { auth_type: "oauth" })).toMatch(
        /JMAP mail account needs its server in url/,
      )
      expect(check("imap", { auth_type: "basic" })).toMatch(
        /IMAP mail account needs its server in url/,
      )
    })
  })

  describe("a mail account", () => {
    const basic = {
      auth_type: "basic" as const,
      username: "ada@example.com",
      secret: "Mail password",
    }

    it("takes a JMAP account with a password, a bearer token or OAuth", () => {
      expect(check("jmap", { ...jmap, ...basic })).toBeNull()
      expect(
        check("jmap", { ...jmap, auth_type: "header", secret: "Mail token" }),
      ).toBeNull()
      expect(
        check("jmap", {
          ...jmap,
          auth_type: "oauth",
          oauth_scope: "urn:ietf:params:oauth:scope:mail offline_access",
          read_only: true,
          mail_from: "ada@example.com",
        }),
      ).toBeNull()
    })

    it("takes an IMAP account with a password, and an SMTP server to send through", () => {
      expect(check("imap", { ...imap, ...basic })).toBeNull()
      expect(
        check("imap", {
          ...imap,
          ...basic,
          smtp_url: "smtps://mail.example.com:465",
        }),
      ).toBeNull()
    })

    it("must sign in, and IMAP only with a user name and password", () => {
      expect(check("jmap", jmap)).toMatch(/signs in: pass auth_type basic/)
      expect(check("jmap", { ...jmap, auth_type: "none" })).toMatch(/signs in/)
      expect(check("imap", { ...imap, auth_type: "oauth" })).toMatch(
        /IMAP account signs in with a user name and password/,
      )
      expect(
        check("imap", { ...imap, auth_type: "header", secret: "token" }),
      ).toMatch(/user name and password/)
    })

    it("sends its bearer token its own way", () => {
      for (const extra of [
        { header_name: "X-Token" },
        { value_template: "{{secret}}" },
        { extra_headers: [{ secret: "x", header_name: "X" }] },
      ]) {
        expect(
          check("jmap", {
            ...jmap,
            auth_type: "header",
            secret: "t",
            ...extra,
          }),
        ).toMatch(/Authorization: Bearer <token>/)
      }
    })

    it("takes smtp_url for IMAP only, and mail_from for mail only", () => {
      expect(
        check("jmap", { ...jmap, ...basic, smtp_url: "smtps://x:465" }),
      ).toMatch(/smtp_url is for kind imap/)
      expect(check("api", { ...api, smtp_url: "smtps://x:465" })).toMatch(
        /smtp_url is for kind imap/,
      )
      expect(check("mcp", { ...mcp, mail_from: "ada@example.com" })).toMatch(
        /mail_from is for kind jmap or imap/,
      )
      expect(check("api", { ...api, mail_from: "ada@example.com" })).toMatch(
        /mail_from is for kind jmap or imap/,
      )
    })
  })

  describe("basic authentication", () => {
    const login = { username: "ada", secret: "Pets password" }

    it("takes an API with a user name and the name of a secret", () => {
      expect(check("api", { ...api, auth_type: "basic", ...login })).toBeNull()
    })

    it("needs both parts, and is not for an MCP server", () => {
      expect(
        check("api", { ...api, auth_type: "basic", secret: "Pets password" }),
      ).toMatch(/needs the user name in username/)
      expect(
        check("api", { ...api, auth_type: "basic", username: "ada" }),
      ).toMatch(/needs the name of the secret that holds the password/)
      expect(check("mcp", { ...mcp, auth_type: "basic", ...login })).toMatch(
        /MCP server sends a secret in a header or signs in with OAuth/,
      )
    })

    it("keeps the user name for basic", () => {
      expect(check("api", { ...api, username: "ada" })).toMatch(
        /username is for auth_type basic/,
      )
      expect(
        check("api", {
          ...api,
          auth_type: "header",
          secret: "k",
          username: "ada",
        }),
      ).toMatch(/username is for auth_type basic/)
    })
  })

  describe("the rest of the authentication", () => {
    it("keeps a client and a scope for OAuth", () => {
      expect(check("mcp", { ...mcp, client_id: "id" })).toMatch(
        /client_id and oauth_scope are for auth_type oauth/,
      )
      expect(
        check("mcp", {
          ...mcp,
          auth_type: "header",
          secret: "k",
          oauth_scope: "x",
        }),
      ).toMatch(/for auth_type oauth/)
    })

    it("keeps extra headers for a header credential", () => {
      expect(
        check("api", {
          ...api,
          extra_headers: [{ secret: "a", header_name: "B" }],
        }),
      ).toMatch(/extra_headers are for auth_type header/)
    })

    it("takes a secret with OAuth only as its client's", () => {
      expect(check("mcp", { ...mcp, auth_type: "oauth", secret: "s" })).toMatch(
        /pass client_id too, or leave secret out/,
      )
    })

    it("names the secret a header sends", () => {
      expect(check("mcp", { ...mcp, auth_type: "header" })).toMatch(
        /needs the name of a secret the owner stored in PCP/,
      )
    })

    it("keeps read_only for an API or a mail account", () => {
      expect(check("mcp", { ...mcp, read_only: true })).toMatch(
        /read_only is for an API.*or a mail account/,
      )
      expect(check("api", { ...api, read_only: false })).toBeNull()
    })
  })
})
