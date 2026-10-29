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

    it("keeps read_only for an API, a mail or a calendar account", () => {
      expect(check("mcp", { ...mcp, read_only: true })).toMatch(
        /read_only is for an API.*a mail account.*or a calendar account/,
      )
      expect(check("api", { ...api, read_only: false })).toBeNull()
    })
  })
})

describe("a calendar account", () => {
  const caldav = { url: "caldav.icloud.com" }
  const basic = {
    auth_type: "basic" as const,
    username: "ada@icloud.com",
    secret: "iCloud app password",
  }

  it("is the kind named, and needs its server", () => {
    expect(resolveKind({ kind: "caldav" })).toBe("caldav")
    expect(checkRegisterShape("caldav", { ...basic })).toMatch(
      /needs its CalDAV server in url, like caldav\.icloud\.com/,
    )
  })

  it("signs in with a login, a bearer token or OAuth, and may be read-only", () => {
    expect(checkRegisterShape("caldav", { ...caldav, ...basic })).toBeNull()
    expect(
      checkRegisterShape("caldav", { ...caldav, ...basic, read_only: true }),
    ).toBeNull()
    expect(
      checkRegisterShape("caldav", {
        ...caldav,
        auth_type: "header",
        secret: "Calendar token",
      }),
    ).toBeNull()
    expect(
      checkRegisterShape("caldav", { ...caldav, auth_type: "oauth" }),
    ).toBeNull()
  })

  it("is refused without a sign-in, with a header of its own, or with mail's arguments", () => {
    expect(checkRegisterShape("caldav", caldav)).toMatch(
      /signs in: pass auth_type basic .*app-specific password/,
    )
    expect(
      checkRegisterShape("caldav", {
        ...caldav,
        auth_type: "header",
        secret: "token",
        header_name: "X-Token",
      }),
    ).toMatch(/Authorization: Bearer/)
    expect(
      checkRegisterShape("caldav", { ...caldav, ...basic, smtp_url: "x" }),
    ).toMatch(/smtp_url is for kind imap/)
    expect(
      checkRegisterShape("caldav", { ...caldav, ...basic, mail_from: "a@b.c" }),
    ).toMatch(/mail_from is for kind jmap or imap/)
  })
})

describe("another server of a definition (definition)", () => {
  const bound = { definition: "coolify-gaaf", url: "https://plek.example/v1" }

  it("takes its kind from the definition when none is named", () => {
    expect(resolveKind({}, "openapi")).toBe("api")
    expect(resolveKind({}, "mcp")).toBe("mcp")
    expect(resolveKind({ kind: "mcp" }, "openapi")).toBe("mcp")
  })

  it("takes the instance's own part: an address, a sign-in, read-only", () => {
    expect(checkRegisterShape("api", bound)).toBeNull()
    expect(
      checkRegisterShape("api", {
        ...bound,
        read_only: true,
        auth_type: "header",
        secret: "Plek key",
      }),
    ).toBeNull()
    expect(
      checkRegisterShape("api", {
        ...bound,
        auth_type: "basic",
        username: "ada",
        secret: "Plek password",
      }),
    ).toBeNull()
    expect(
      checkRegisterShape("mcp", {
        definition: "linear",
        url: "https://mcp.linear.example/mcp",
        auth_type: "oauth",
      }),
    ).toBeNull()
  })

  it("brings none of what the definition is: no schema, edits or description", () => {
    for (const extra of [
      { openapi_schema: "{}" },
      { openapi_url: "https://example.com/o.json" },
      { spec_patches: [] },
    ]) {
      expect(checkRegisterShape("api", { ...bound, ...extra })).toMatch(
        /the schema and its edits are the definition's/,
      )
    }
    expect(
      checkRegisterShape("api", { ...bound, description: "Mine." }),
    ).toMatch(/the description is the definition's/)
  })

  it("needs an address of its own, and is not for a mail or calendar account", () => {
    expect(checkRegisterShape("api", { definition: "coolify-gaaf" })).toMatch(
      /pass the base URL .* in url/,
    )
    expect(checkRegisterShape("mcp", { definition: "linear" })).toMatch(
      /pass this server's address in url/,
    )
    expect(
      checkRegisterShape("jmap", {
        ...bound,
        auth_type: "basic",
        username: "ada",
        secret: "x",
      }),
    ).toMatch(/definition is for an MCP server, an API or a service/)
  })
})

describe("a service (kind service)", () => {
  const service = { service: { image: "x" }, ssh_server: "build-box" }

  it("is the kind named, or the one a definition in service makes", () => {
    expect(resolveKind({ service: {} })).toBe("service")
    expect(resolveKind({ kind: "service" })).toBe("service")
    expect(resolveKind({}, "service")).toBe("service")
    expect(resolveKind({ openapi_schema: "{}", service: {} })).toBe("service")
  })

  it("takes its definition, the SSH server, where it is published and its secrets", () => {
    expect(checkRegisterShape("service", service)).toBeNull()
    expect(
      checkRegisterShape("service", {
        ...service,
        description: "Documents to Markdown.",
        publish_address: "10.0.0.5",
        publish_ports: [{ container: 5001, host: 8001 }],
        env_secrets: [{ name: "API_KEY", secret: "Docling key" }],
      }),
    ).toBeNull()
  })

  it("needs a definition and an SSH server", () => {
    expect(checkRegisterShape("service", { ssh_server: "build-box" })).toMatch(
      /from its definition in service/,
    )
    expect(checkRegisterShape("service", { service: {} })).toMatch(
      /pass its short name in ssh_server/,
    )
  })

  it("takes none of the other kinds' arguments, and signs in to nothing", () => {
    expect(
      checkRegisterShape("service", { ...service, url: "https://x" }),
    ).toMatch(/takes none of url/)
    expect(
      checkRegisterShape("service", { ...service, secret: "Docling key" }),
    ).toMatch(/takes none of secret/)
    expect(
      checkRegisterShape("service", { ...service, read_only: true }),
    ).toMatch(/takes none of read_only/)
    expect(
      checkRegisterShape("service", { ...service, auth_type: "header" }),
    ).toMatch(/signs in to nothing/)
  })

  it("keeps its own arguments out of every other kind", () => {
    expect(
      checkRegisterShape("mcp", {
        url: "https://mcp.example.com/mcp",
        ssh_server: "build-box",
      }),
    ).toMatch(/ssh_server is for kind service/)
    expect(
      checkRegisterShape("api", {
        openapi_schema: "{}",
        env_secrets: [],
        publish_ports: [],
      }),
    ).toMatch(/publish_ports, env_secrets are for kind service/)
    expect(
      checkRegisterShape("caldav", {
        url: "caldav.icloud.com",
        auth_type: "oauth",
        service: {},
        publish_address: "0.0.0.0",
      }),
    ).toMatch(/service, publish_address are for kind service/)
  })

  it("as another of a definition, brings only its own part", () => {
    expect(
      checkRegisterShape("service", {
        definition: "docling-service",
        ssh_server: "build-box",
        env_secrets: [{ name: "API_KEY", secret: "Docling key" }],
      }),
    ).toBeNull()
    expect(
      checkRegisterShape("service", {
        definition: "docling-service",
        ...service,
      }),
    ).toMatch(/leave service out/)
    expect(
      checkRegisterShape("service", {
        definition: "docling-service",
        ssh_server: "build-box",
        description: "Mine.",
      }),
    ).toMatch(/leave description out/)
  })
})
