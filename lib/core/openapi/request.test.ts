import { describe, expect, it } from "vitest"

import type { CallPlan, ParamPlan } from "./plan"
import { buildRequest } from "./request"

const BASE = "https://api.example.com/v1"

function param(
  overrides: Partial<ParamPlan> & Pick<ParamPlan, "arg">,
): ParamPlan {
  return {
    name: overrides.arg,
    in: "query",
    required: false,
    style: "form",
    explode: true,
    ...overrides,
  }
}

function plan(overrides: Partial<CallPlan> = {}): CallPlan {
  return {
    v: 1,
    method: "GET",
    path: "/pets",
    params: [],
    body: null,
    accept: "application/json",
    ...overrides,
  }
}

const pathPlan = plan({
  path: "/pets/{petId}",
  params: [
    param({
      arg: "petId",
      in: "path",
      required: true,
      style: "simple",
      explode: false,
    }),
  ],
})

describe("path parameters", () => {
  it("are percent-encoded, so they stay one segment", () => {
    const { url } = buildRequest(pathPlan, BASE, { petId: "a/b?c#d %" }, {})
    expect(url).toBe("https://api.example.com/v1/pets/a%2Fb%3Fc%23d%20%25")
  })

  it("refuse a dot segment, which the URL parser would resolve away", () => {
    expect(() => buildRequest(pathPlan, BASE, { petId: "" }, {})).toThrow(
      /cannot be empty/,
    )
    for (const petId of ["..", "."]) {
      expect(() => buildRequest(pathPlan, BASE, { petId }, {})).toThrow(
        /cannot have "\." or "\.\." between slashes/,
      )
    }
    // An already-encoded dot is encoded again, so it stays a literal name.
    expect(buildRequest(pathPlan, BASE, { petId: "%2e%2e" }, {}).url).toBe(
      "https://api.example.com/v1/pets/%252e%252e",
    )
  })

  it("cannot spell a path with an encoded slash, which a decoding proxy would resolve", () => {
    // Encoded, "../../admin" stays one segment here: ..%2F..%2Fadmin. A
    // server or proxy that decodes %2F before it tidies the path reads it as
    // /admin, so a dot component is refused however the slashes are written.
    for (const petId of [
      "../../admin",
      "a/../b",
      "a\\..\\b",
      "a/./b",
      "./x",
      "x/..",
    ]) {
      expect(() => buildRequest(pathPlan, BASE, { petId }, {}), petId).toThrow(
        /between slashes/,
      )
    }
    expect(() =>
      buildRequest(pathPlan, BASE, { petId: ["ok", "../x"] }, {}),
    ).toThrow(/between slashes/)
  })

  it("still takes values that only look like it", () => {
    for (const petId of [
      "a..b",
      "..hidden",
      "x/.hidden/y",
      "v1.2",
      "...",
      "a/b",
    ]) {
      const { url } = buildRequest(pathPlan, BASE, { petId }, {})
      expect(new URL(url).origin, petId).toBe("https://api.example.com")
      expect(new URL(url).pathname.startsWith("/v1/pets/"), petId).toBe(true)
    }
  })

  it("reports a character that cannot be encoded, not a crash", () => {
    expect(() =>
      buildRequest(pathPlan, BASE, { petId: "bad\uD800" }, {}),
    ).toThrow(/character that cannot be sent/)
  })

  it("take numbers and lists, and reject objects they cannot express", () => {
    expect(buildRequest(pathPlan, BASE, { petId: 7 }, {}).url).toMatch(
      /\/pets\/7$/,
    )
    expect(buildRequest(pathPlan, BASE, { petId: [1, 2] }, {}).url).toMatch(
      /\/pets\/1,2$/,
    )
    expect(() => buildRequest(pathPlan, BASE, { petId: [{}] }, {})).toThrow(
      /string, a number/,
    )
  })
})

describe("query parameters", () => {
  const q = (p: Partial<ParamPlan>, value: unknown) =>
    new URL(
      buildRequest(
        plan({ params: [param({ arg: "f", ...p })] }),
        BASE,
        { f: value },
        {},
      ).url,
    ).search

  it("repeat a key for an exploded array, or join for a compact one", () => {
    expect(q({}, ["a", "b"])).toBe("?f=a&f=b")
    expect(q({ explode: false }, ["a", "b"])).toBe("?f=a%2Cb")
    expect(q({ style: "spaceDelimited", explode: false }, ["a", "b"])).toBe(
      "?f=a+b",
    )
    expect(q({ style: "pipeDelimited", explode: false }, ["a", "b"])).toBe(
      "?f=a%7Cb",
    )
  })

  it("spread objects by style", () => {
    expect(q({}, { a: 1, b: "x" })).toBe("?a=1&b=x")
    expect(q({ explode: false }, { a: 1, b: "x" })).toBe("?f=a%2C1%2Cb%2Cx")
    expect(q({ style: "deepObject" }, { a: 1, b: "x" })).toBe(
      "?f%5Ba%5D=1&f%5Bb%5D=x",
    )
    expect(() => q({}, { a: { deeper: 1 } })).toThrow(/string, a number/)
  })

  it("encode what would end the query or start another", () => {
    expect(q({}, "a&b=c#d")).toBe("?f=a%26b%3Dc%23d")
  })

  it("send JSON for a parameter declared with content", () => {
    expect(q({ serialize: "json" }, { a: [1] })).toBe(
      "?f=%7B%22a%22%3A%5B1%5D%7D",
    )
  })

  it("leave out an optional parameter that is absent or null", () => {
    const p = plan({ params: [param({ arg: "f" })] })
    expect(buildRequest(p, BASE, {}, {}).url).toBe(
      "https://api.example.com/v1/pets",
    )
    expect(buildRequest(p, BASE, { f: null }, {}).url).toBe(
      "https://api.example.com/v1/pets",
    )
  })
})

describe("arguments", () => {
  it("refuse unknown names, listing the known ones, and missing required ones", () => {
    expect(() =>
      buildRequest(pathPlan, BASE, { petId: 1, extra: 1 }, {}),
    ).toThrow('Unknown argument "extra". This tool takes: petId.')
    expect(() => buildRequest(pathPlan, BASE, {}, {})).toThrow(
      'Missing argument "petId".',
    )
    expect(() => buildRequest(pathPlan, BASE, "nope", {})).toThrow(
      /must be an object/,
    )
  })

  it("ignore inherited names like constructor", () => {
    expect(() =>
      buildRequest(pathPlan, BASE, { petId: 1, constructor: 1 }, {}),
    ).toThrow(/Unknown argument "constructor"/)
    expect(() =>
      buildRequest(
        pathPlan,
        BASE,
        JSON.parse('{"petId":1,"__proto__":{"x":1}}'),
        {},
      ),
    ).toThrow(/Unknown argument "__proto__"/)
  })
})

describe("headers", () => {
  const header = (name: string, value: unknown, auth = {}) =>
    buildRequest(
      plan({
        params: [
          param({
            arg: "h",
            name,
            in: "header",
            style: "simple",
            explode: false,
          }),
        ],
      }),
      BASE,
      { h: value },
      auth,
    ).headers

  it("send a declared header", () => {
    expect(header("X-Trace", "abc")["x-trace"]).toBe("abc")
    expect(header("X-Trace", ["a", "b"])["x-trace"]).toBe("a,b")
  })

  it("refuse a value that could carry a second header or request", () => {
    for (const value of [
      "a\r\nX-Evil: 1",
      "a\nb",
      "a\0b",
      "café",
      "x".repeat(9000),
    ]) {
      expect(() => header("X-Trace", value)).toThrow(/cannot carry/)
    }
  })

  it("never let an argument set a header PCP owns", () => {
    for (const name of [
      "Host",
      "Cookie",
      "Authorization",
      "Proxy-Authorization",
      "Content-Length",
      "Content-Type",
      "Transfer-Encoding",
      "Connection",
      "Sec-Fetch-Mode",
      "Proxy-Foo",
      "Bad Name",
      "X-HTTP-Method-Override",
      "X-Method-Override",
      "X-Forwarded-For",
      "X-Forwarded-Host",
      "X-Real-IP",
      "Forwarded",
      "Origin",
      "Referer",
      "Via",
      "X-Original-URL",
      "X-Rewrite-URL",
    ]) {
      const sent = header(name, "evil")
      expect(sent[name.toLowerCase()], name).toBeUndefined()
    }
  })

  it("put the credential last, over anything an argument sent", () => {
    const headers = header("X-Api-Key", "from-the-assistant", {
      "X-Api-Key": "the-real-secret",
    })
    expect(headers["x-api-key"]).toBe("the-real-secret")
  })

  it("set accept and a user agent", () => {
    const headers = buildRequest(plan(), BASE, {}, {}).headers
    expect(headers.accept).toBe("application/json")
    expect(headers["user-agent"]).toMatch(/^pcp\//)
  })
})

describe("bodies", () => {
  const withBody = (encoding: "json" | "form" | "text", value: unknown) =>
    buildRequest(
      plan({
        method: "POST",
        body: {
          arg: "body",
          contentType: `x/${encoding}`,
          encoding,
          required: true,
        },
      }),
      BASE,
      { body: value },
      {},
    )

  it("encodes JSON, form and text", () => {
    expect(withBody("json", { a: [1] }).body).toBe('{"a":[1]}')
    expect(withBody("form", { a: "x y", b: [1, 2] }).body).toBe("a=x+y&b=1&b=2")
    expect(withBody("text", "hello").body).toBe("hello")
    expect(withBody("json", { a: 1 }).headers["content-type"]).toBe("x/json")
  })

  it("requires a required body, and skips an absent optional one", () => {
    const required = plan({
      method: "POST",
      body: {
        arg: "body",
        contentType: "application/json",
        encoding: "json",
        required: true,
      },
    })
    expect(() => buildRequest(required, BASE, {}, {})).toThrow(
      'Missing argument "body".',
    )

    const optional = plan({
      method: "POST",
      body: {
        arg: "body",
        contentType: "application/json",
        encoding: "json",
        required: false,
      },
    })
    const built = buildRequest(optional, BASE, {}, {})
    expect(built.body).toBeUndefined()
    expect(built.headers["content-type"]).toBeUndefined()
  })

  it("refuses a form body that is not an object, and an oversized one", () => {
    expect(() => withBody("form", "nope")).toThrow(/object of form fields/)
    expect(() => withBody("json", "x".repeat(1024 * 1024 + 1))).toThrow(
      /larger than 1 MB/,
    )
  })
})

describe("the finished url", () => {
  it("stays under the base url's path, including a bare origin", () => {
    expect(buildRequest(plan(), "https://api.example.com", {}, {}).url).toBe(
      "https://api.example.com/pets",
    )
    expect(
      buildRequest(plan(), "https://api.example.com/v1/", {}, {}).url,
    ).toBe("https://api.example.com/v1/pets")
  })

  it("keeps a path that looks like a host on the base origin", () => {
    // Setting pathname cannot change the host, so a stored plan with
    // "//evil.example/x" still goes to the base URL's origin, as a path.
    const { url } = buildRequest(
      plan({ path: "//evil.example/x" }),
      BASE,
      {},
      {},
    )
    expect(new URL(url).origin).toBe("https://api.example.com")
    expect(new URL(url).pathname).toBe("/v1//evil.example/x")
  })

  it("refuses a plan with an unfilled placeholder", () => {
    expect(() =>
      buildRequest(plan({ path: "/pets/{petId}" }), BASE, {}, {}),
    ).toThrow(/unfilled/)
  })
})

describe("paths that mean something else to some servers", () => {
  it("encodes a semicolon in a value, so '..;' is not a dot segment for servers that read it as one", () => {
    expect(buildRequest(pathPlan, BASE, { petId: "..;" }, {}).url).toBe(
      "https://api.example.com/v1/pets/..%3B",
    )
    expect(buildRequest(pathPlan, BASE, { petId: "a;b=c" }, {}).url).toBe(
      "https://api.example.com/v1/pets/a%3Bb%3Dc",
    )
  })

  it("keeps a literal path template that normalizes away from leaving the base path", () => {
    // These come from the schema, which an assistant may have written. The
    // URL parser removes the dot segments; the prefix check then refuses.
    for (const path of [
      "/../admin",
      "/%2e%2e/admin",
      "/.%2E/admin",
      "/a/../../admin",
    ]) {
      expect(() => buildRequest(plan({ path }), BASE, {}, {}), path).toThrow(
        /leave the endpoint's base URL/,
      )
    }
  })
})

describe("values PCP sends itself", () => {
  const fixed = plan({
    params: [
      param({
        arg: "X-Requested-With",
        in: "header",
        required: true,
        style: "simple",
        explode: false,
        value: "XMLHttpRequest",
      }),
      param({ arg: "format", value: "json" }),
    ],
  })

  it("sends them without an argument", () => {
    const built = buildRequest(fixed, BASE, {}, {})

    expect(built.headers["x-requested-with"]).toBe("XMLHttpRequest")
    expect(built.url).toBe(`${BASE}/pets?format=json`)
  })

  it("does not take them as arguments", () => {
    expect(() => buildRequest(fixed, BASE, { format: "xml" }, {})).toThrow(
      /Unknown argument "format"/,
    )
  })
})
