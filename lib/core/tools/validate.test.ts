import { describe, expect, it } from "vitest"

import { MAX_ARGUMENT_PROBLEMS } from "./limits"
import { riskyPattern, sameJson, validate } from "./validate"

const object = (
  properties: Record<string, unknown>,
  more: Record<string, unknown> = {},
) => ({ type: "object", properties, additionalProperties: false, ...more })

describe("validate: objects", () => {
  it("names a missing argument and an unknown one, with the ones it takes", () => {
    const problems = validate(
      object(
        { to: { type: "string" }, copies: { type: "integer" } },
        { required: ["to"] },
      ),
      { recipient: "Grace" },
    )

    expect(problems).toEqual([
      '"to" is missing; the inputSchema requires it.',
      '"recipient" is not an argument of this tool (it takes: to, copies).',
    ])
  })

  it("names a nested key by its path, and what the object there takes", () => {
    const problems = validate(
      object({ address: object({ city: { type: "string" } }) }),
      { address: { city: "Delft", zip: "2611" } },
    )

    expect(problems).toEqual([
      '"address/zip" is not a key the inputSchema allows in "address" (it takes: city).',
    ])
  })

  it("lets an open object take any key, and checks those it describes", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: { type: "number" },
    }

    expect(validate(schema, { a: "x", b: 1 })).toEqual([])
    expect(validate(schema, { b: "1" })).toEqual([
      '"b" is string, but the inputSchema says number.',
    ])
    expect(validate({ type: "object" }, { anything: [1] })).toEqual([])
  })

  it("reads patternProperties, propertyNames, counts and dependencies", () => {
    expect(
      validate(
        {
          type: "object",
          patternProperties: { "^x-": { type: "string" } },
          additionalProperties: false,
        },
        { "x-one": "a", other: 1 },
      ),
    ).toEqual(['"other" is not an argument of this tool (it takes: none).'])
    expect(
      validate(
        { type: "object", propertyNames: { pattern: "^[a-z]+$" } },
        { ok: 1, NotOk: 2 },
      ),
    ).toEqual(['"NotOk" is not a key name the inputSchema allows.'])
    expect(
      validate(
        { type: "object", minProperties: 2, maxProperties: 3 },
        {
          a: 1,
        },
      ),
    ).toEqual([
      "The arguments has 1 keys, but the inputSchema says at least 2.",
    ])
    expect(
      validate(
        { type: "object", dependentRequired: { card: ["expiry"] } },
        { card: "4111" },
      ),
    ).toEqual(['"expiry" is missing; the inputSchema requires it with "card".'])
  })

  it("takes the keys subschemas name for unevaluatedProperties", () => {
    const schema = {
      type: "object",
      allOf: [{ properties: { a: { type: "string" } } }],
      properties: { b: { type: "string" } },
      unevaluatedProperties: false,
    }

    expect(validate(schema, { a: "1", b: "2" })).toEqual([])
    expect(validate(schema, { c: "3" })).toEqual([
      '"c" is not an argument of this tool (it takes: b).',
    ])
  })
})

describe("validate: values", () => {
  it("checks types, enum and const", () => {
    const schema = object({
      copies: { type: "integer" },
      size: { enum: ["A6", "A5"] },
      kind: { const: "card" },
      maybe: { type: ["string", "null"] },
    })

    expect(
      validate(schema, { copies: "two", size: "A4", kind: "letter" }),
    ).toEqual([
      '"copies" is string, but the inputSchema says integer.',
      '"size" is not one of the inputSchema\'s enum values ("A6", "A5").',
      '"kind" is not "card", which the inputSchema requires.',
    ])
    expect(validate(schema, { copies: 1.5 })).toEqual([
      '"copies" is number, but the inputSchema says integer.',
    ])
    expect(validate(schema, { maybe: null, copies: 2 })).toEqual([])
    expect(
      validate(object({ s: { enum: [{ a: 1, b: 2 }] } }), {
        s: { b: 2, a: 1 },
      }),
    ).toEqual([])
  })

  it("counts lengths in characters, not UTF-16 units", () => {
    const schema = object({ name: { type: "string", maxLength: 2 } })

    expect(validate(schema, { name: "😀😀" })).toEqual([])
    expect(validate(schema, { name: "abc" })).toEqual([
      '"name" is 3 characters long, but the inputSchema says at most 2.',
    ])
    expect(
      validate(object({ name: { type: "string", minLength: 1 } }), {
        name: "",
      }),
    ).toEqual([
      '"name" is 0 characters long, but the inputSchema says at least 1.',
    ])
  })

  it("runs a pattern, and leaves one that could take exponential time to the tool", () => {
    expect(
      validate(object({ id: { type: "string", pattern: "^[a-z]+$" } }), {
        id: "ABC",
      }),
    ).toEqual(['"id" does not match the inputSchema\'s pattern ^[a-z]+$.'])
    expect(
      validate(object({ id: { type: "string", pattern: "^(a+)+$" } }), {
        id: `${"a".repeat(40)}!`,
      }),
    ).toEqual([])
    expect(riskyPattern("^(a+)+$")).toBe(true)
    expect(riskyPattern("^(a|aa)*$")).toBe(true)
    expect(riskyPattern("^(\\w)\\1$")).toBe(true)
    expect(riskyPattern("^[a-z0-9-]+$")).toBe(false)
    expect(riskyPattern("^\\d{4}-\\d{2}-\\d{2}$")).toBe(false)
    expect(riskyPattern("^(ab)+$")).toBe(false)
  })

  it("checks the formats it knows and lets others be", () => {
    const schema = (format: string) => object({ v: { type: "string", format } })

    expect(validate(schema("date"), { v: "2026-02-30" })).toEqual([
      '"v" is not a valid date, such as 2026-10-29.',
    ])
    expect(validate(schema("date"), { v: "2026-02-28" })).toEqual([])
    expect(validate(schema("date-time"), { v: "2026-10-29" })).toHaveLength(1)
    expect(
      validate(schema("date-time"), { v: "2026-10-29T14:30:00.5+02:00" }),
    ).toEqual([])
    expect(validate(schema("email"), { v: "ada" })).toHaveLength(1)
    expect(validate(schema("email"), { v: "ada@example.com" })).toEqual([])
    expect(validate(schema("uri"), { v: "/relative" })).toHaveLength(1)
    expect(validate(schema("uri"), { v: "https://example.com/a" })).toEqual([])
    expect(validate(schema("uuid"), { v: "nope" })).toHaveLength(1)
    expect(validate(schema("ipv4"), { v: "300.1.1.1" })).toHaveLength(1)
    expect(validate(schema("color"), { v: "anything" })).toEqual([])
  })

  it("checks numbers' bounds, in both forms of the exclusive ones", () => {
    const schema = object({
      a: { type: "number", minimum: 1, maximum: 5 },
      b: { type: "number", exclusiveMinimum: 0 },
      c: { type: "number", maximum: 10, exclusiveMaximum: true },
      d: { type: "number", multipleOf: 0.1 },
    })

    expect(validate(schema, { a: 3, b: 0.1, c: 9.9, d: 0.3 })).toEqual([])
    expect(validate(schema, { a: 6, b: 0, c: 10, d: 0.35 })).toEqual([
      '"a" is 6, but the inputSchema says at most 5.',
      '"b" is 0, but the inputSchema says more than 0.',
      '"c" is 10, but the inputSchema says less than 10.',
      '"d" is 0.35, but the inputSchema says a multiple of 0.1.',
    ])
  })

  it("checks arrays: items, tuples old and new, counts, uniqueness, contains", () => {
    expect(
      validate(object({ tags: { type: "array", items: { type: "string" } } }), {
        tags: ["a", 2],
      }),
    ).toEqual(['"tags/1" is integer, but the inputSchema says string.'])
    expect(
      validate(
        object({
          pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            items: false,
          },
        }),
        { pair: ["a", 1, true] },
      ),
    ).toEqual(['"pair" has 3 items, but the inputSchema says at most 2.'])
    expect(
      validate(
        object({
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        }),
        { pair: [1, "a"] },
      ),
    ).toHaveLength(2)
    expect(
      validate(
        object({
          ids: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true },
        }),
        { ids: [{ a: 1 }, { a: 1 }] },
      ),
    ).toEqual([
      '"ids" has the same item twice, but the inputSchema says its items are unique.',
    ])
    expect(
      validate(object({ ids: { type: "array", contains: { const: "me" } } }), {
        ids: ["you"],
      }),
    ).toHaveLength(1)
  })
})

describe("validate: composition", () => {
  it("takes oneOf as exactly one, and anyOf as at least one", () => {
    const oneOf = object({
      v: { oneOf: [{ type: "string" }, { type: "string", maxLength: 3 }] },
    })

    expect(validate(oneOf, { v: "long one" })).toEqual([])
    expect(validate(oneOf, { v: "ab" })).toEqual([
      '"v" matches 2 of the inputSchema\'s oneOf options, and it should match exactly one.',
    ])
    expect(
      validate(
        object({ v: { anyOf: [{ type: "string" }, { type: "number" }] } }),
        {
          v: true,
        },
      ),
    ).toEqual([
      '"v" matches none of the inputSchema\'s anyOf options; the closest says: "v" is boolean, but the inputSchema says string.',
    ])
  })

  it("names the option an object comes closest to", () => {
    const schema = object({
      shape: {
        anyOf: [
          object(
            { kind: { const: "circle" }, r: { type: "number" } },
            {
              required: ["kind", "r"],
            },
          ),
          object(
            { kind: { const: "square" }, side: { type: "number" } },
            {
              required: ["kind", "side"],
            },
          ),
        ],
      },
    })

    expect(validate(schema, { shape: { kind: "square" } })).toEqual([
      '"shape" matches none of the inputSchema\'s anyOf options; the closest says: "shape/side" is missing; the inputSchema requires it.',
    ])
  })

  it("reads allOf, not and if/then/else", () => {
    expect(
      validate(
        object({ v: { allOf: [{ type: "string" }, { minLength: 2 }] } }),
        { v: "a" },
      ),
    ).toEqual(['"v" is 1 character long, but the inputSchema says at least 2.'])
    expect(
      validate(object({ v: { not: { const: "root" } } }), { v: "root" }),
    ).toEqual(['"v" is what the inputSchema rules out (its "not").'])

    const conditional = {
      type: "object",
      if: { properties: { kind: { const: "card" } } },
      then: { required: ["number"] },
      else: { required: ["iban"] },
    }

    expect(validate(conditional, { kind: "card" })).toEqual([
      '"number" is missing; the inputSchema requires it.',
    ])
    expect(validate(conditional, { kind: "bank" })).toEqual([
      '"iban" is missing; the inputSchema requires it.',
    ])
  })
})

describe("validate: references", () => {
  it("follows references inside the schema", () => {
    const schema = {
      type: "object",
      properties: { pet: { $ref: "#/$defs/pet" } },
      $defs: {
        pet: object({ name: { type: "string" } }, { required: ["name"] }),
      },
    }

    expect(validate(schema, { pet: { name: "Rex" } })).toEqual([])
    expect(validate(schema, { pet: {} })).toEqual([
      '"pet/name" is missing; the inputSchema requires it.',
    ])
  })

  it("follows a recursive one as deep as the value goes, and stops a loop", () => {
    const tree = {
      $defs: {
        node: {
          type: "object",
          properties: {
            value: { type: "number" },
            children: { type: "array", items: { $ref: "#/$defs/node" } },
          },
        },
      },
      type: "object",
      properties: { root: { $ref: "#/$defs/node" } },
    }

    expect(
      validate(tree, { root: { children: [{ children: [{ value: "x" }] }] } }),
    ).toEqual([
      '"root/children/0/children/0/value" is string, but the inputSchema says number.',
    ])
    expect(
      validate(
        { type: "object", properties: { a: { $ref: "#/properties/a" } } },
        {
          a: 1,
        },
      )[0],
    ).toMatch(/refers to itself more than \d+ times in a row/)
  })

  it("refuses a reference to another document, and one it does not define", () => {
    expect(
      validate(object({ pet: { $ref: "https://example.com/pet.json" } }), {
        pet: {},
      }),
    ).toEqual([
      'The inputSchema refers to "https://example.com/pet.json", outside itself; PCP never fetches another document, so it cannot check these arguments. The tool\'s schema needs its definitions inside it (#/$defs/…).',
    ])
    expect(
      validate(object({ pet: { $ref: "#/$defs/missing" } }), { pet: {} }),
    ).toEqual([
      'The inputSchema refers to "#/$defs/missing", which it does not define.',
    ])
  })
})

describe("validate: handles and secrets", () => {
  it("lets a kept result's handle stand for a string, and only a string", () => {
    const schema = object({
      body: { type: "string", maxLength: 3, pattern: "^x" },
      count: { type: "integer" },
      either: { anyOf: [{ type: "string" }, { type: "number" }] },
    })

    expect(
      validate(schema, {
        body: { $result: "abc" },
        either: { $result: "abc", as: "base64" },
      }),
    ).toEqual([])
    expect(validate(schema, { count: { $result: "abc" } })).toEqual([
      '"count" is a kept result\'s handle (which stands for a string), but the inputSchema says integer.',
    ])
  })

  it("checks an attachment that names a result as the object it is", () => {
    const schema = object({
      attachments: {
        type: "array",
        items: object(
          { $result: { type: "string" }, name: { type: "string" } },
          { required: ["$result"] },
        ),
      },
    })

    expect(
      validate(schema, {
        attachments: [{ $result: "r1" }, { $result: "r2", name: "a.pdf" }],
      }),
    ).toEqual([])
    expect(
      validate(schema, { attachments: [{ $result: "r1", size: 3 }] }),
    ).toHaveLength(1)
  })

  it("takes a secret's placeholder only where it is let in", () => {
    const schema = object({ text: { type: "string" } })
    const secret = { text: { $secret: "Password" } }

    expect(validate(schema, secret)).toHaveLength(1)
    expect(
      validate(schema, secret, { secretAt: (pointer) => pointer === "/text" }),
    ).toEqual([])
    expect(
      validate(
        object({ other: { type: "string" } }),
        { other: { $secret: "P" } },
        {
          secretAt: (pointer) => pointer === "/text",
        },
      ),
    ).toHaveLength(1)
  })
})

describe("validate: bounds", () => {
  it("names at most MAX_ARGUMENT_PROBLEMS problems", () => {
    const args = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`k${index}`, 1]),
    )

    expect(validate(object({}), args)).toHaveLength(MAX_ARGUMENT_PROBLEMS)
  })

  it("refuses a value too large to look through", () => {
    const schema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
      },
    }
    const problems = validate(schema, {
      list: Array.from({ length: 100_000 }, () => "x"),
    })

    expect(problems).toEqual([
      "The arguments are too large for PCP to check against the inputSchema: send fewer or smaller values.",
    ])
  })

  it("honours OpenAPI's nullable", () => {
    expect(
      validate(object({ note: { type: "string", nullable: true } }), {
        note: null,
      }),
    ).toEqual([])
  })

  it("compares JSON as JSON", () => {
    expect(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(sameJson([1, 2], [2, 1])).toBe(false)
  })
})
