import { describe, expect, it } from "vitest"

import { secretLiterals } from "./secret-literals"

// The secrets a flow's program names as written (#120), read from its text
// without running it: literals in every quoting QuickJS takes, never a name
// worked out as it runs, never one in a comment or inside another string.

describe("the secrets a program names as written", () => {
  it("finds {$secret: name} in each quoting, with the part it types", () => {
    const program = `
      await pcp.call("browser", "type", { tab, target, text: {"$secret": "DigiD password"} })
      await pcp.call("browser", "type", { tab, target, text: { $secret: 'DigiD password', part: "username" } })
      await pcp.call("browser", "type", { tab, text: { 'part': 'password', '$secret': "Bank" } })
      await pcp.call("browser", "type", { tab, text: { $secret: \`Mail\` } })
      await pcp.call("browser", "type", { tab, text: { "$secret": "Caf\\u00e9 \\"pin\\"" } })
    `

    expect(secretLiterals(program)).toEqual([
      { name: "DigiD password", parts: ["username", "password"] },
      { name: "Bank", parts: ["password"] },
      { name: "Mail", parts: ["password"] },
      { name: 'Café "pin"', parts: ["password"] },
    ])
  })

  it("leaves out a name worked out as it runs", () => {
    const program = `
      const which = args.account
      await pcp.call("browser", "type", { tab, text: { $secret: which } })
      await pcp.call("browser", "type", { tab, text: { $secret: "Bank " + which } })
      await pcp.call("browser", "type", { tab, text: { $secret: \`Bank \${which}\` } })
      await pcp.call("browser", "type", { tab, text: { $secret: args.name, part: "username" } })
      await pcp.call("browser", "type", { tab, text: { [key]: "Computed" } })
      await pcp.call("browser", "type", { tab, text: { $secret } })
    `

    expect(secretLiterals(program)).toEqual([])
  })

  it("reads a part worked out as it runs as either", () => {
    expect(
      secretLiterals(
        'pcp.call("browser", "type", { text: { $secret: "Shop", part: args.part } })',
      ),
    ).toEqual([{ name: "Shop", parts: ["username", "password"] }])
  })

  it("skips comments, strings, regular expressions and objects that are no placeholder", () => {
    const program = `
      // { $secret: "In a line comment" }
      /* { "$secret": "In a block comment" } */
      const said = '{ "$secret": "In a string" }'
      const shown = \`{ $secret: "In a template" }\`
      const pattern = /{ $secret: "In a pattern" }/g
      const other = { $secret: "With another key", tab: 1 }
      const spread = { ...base, $secret: "Spread in" }
      const nested = { text: { inner: { $secret: "Deep" } } }
    `

    expect(secretLiterals(program).map((found) => found.name)).toEqual(["Deep"])
  })

  it("reads past an odd bracket or an unclosed string without losing the rest", () => {
    const program = `
      const broken = "no end
      const fine = { $secret: "After" }
    `
    expect(secretLiterals(program).map((found) => found.name)).toEqual([
      "After",
    ])
  })

  it("finds objects inside a template's expressions", () => {
    expect(
      secretLiterals(
        'const x = `${JSON.stringify({ $secret: "Inside" })} and ${a}`',
      ),
    ).toEqual([{ name: "Inside", parts: ["password"] }])
  })

  it("does not count an object with a computed key", () => {
    expect(
      secretLiterals(
        'const k = "part"; pcp.call("browser", "type", { text: { $secret: "Shop", [k]: "password" } })',
      ),
    ).toEqual([])
  })

  it("finds nothing nested past its depth, and never runs out of stack", () => {
    const deepObject = `${"{ a: ".repeat(100)}{ $secret: "Deep" }${" }".repeat(100)}`
    expect(secretLiterals(`const x = ${deepObject}`)).toEqual([])

    const deepTemplate = `${"`${".repeat(100)}({ $secret: "Inside" })${"}`".repeat(100)}`
    expect(secretLiterals(`const x = ${deepTemplate}`)).toEqual([])

    const huge = `${"`${".repeat(20_000)}1${"}`".repeat(20_000)}`
    expect(() => secretLiterals(`const x = ${huge}`)).not.toThrow()

    // Within the depth, found.
    const shallow = `${"{ a: ".repeat(10)}{ $secret: "Near" }${" }".repeat(10)}`
    expect(secretLiterals(`const x = ${shallow}`)).toEqual([
      { name: "Near", parts: ["password"] },
    ])
  })
})
