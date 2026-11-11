import { describe, expect, it } from "vitest"

import {
  decodeMessage,
  decodeQuery,
  DnsWireError,
  encodeQuery,
  followChain,
  TYPE_A,
  TYPE_AAAA,
  TYPE_CNAME,
} from "./dns-wire"
import { answerFor } from "./fake-doh"

describe("encodeQuery", () => {
  it("writes one question with id 0 and recursion desired", () => {
    const query = encodeQuery("Example.COM.", TYPE_AAAA)

    expect(query.readUInt16BE(0)).toBe(0)
    expect(query.readUInt16BE(2)).toBe(0x0100)
    expect(query.readUInt16BE(4)).toBe(1)
    expect(query.subarray(12).toString("hex")).toBe(
      // 7 example 3 com 0, type 28, class 1
      "076578616d706c6503636f6d00001c0001",
    )
    expect(decodeQuery(query)).toEqual({ name: "example.com", type: TYPE_AAAA })
  })

  it("refuses what is not a host name", () => {
    expect(() => encodeQuery("a..b", TYPE_A)).toThrow(DnsWireError)
    expect(() => encodeQuery(`${"a".repeat(64)}.com`, TYPE_A)).toThrow(
      DnsWireError,
    )
    expect(() => encodeQuery("exa mple.com", TYPE_A)).toThrow(DnsWireError)
  })
})

describe("decodeMessage", () => {
  it("reads A, AAAA and CNAME records", () => {
    const records = {
      "www.example.com": { cname: "edge.example.net", ttl: 60 },
      "edge.example.net": {
        a: ["93.184.216.34"],
        aaaa: ["2606:2800:220:1::1"],
        ttl: 30,
      },
    }
    const v4 = decodeMessage(
      answerFor(records, { name: "www.example.com", type: TYPE_A }),
    )
    const v6 = decodeMessage(
      answerFor(records, { name: "www.example.com", type: TYPE_AAAA }),
    )

    expect(v4.rcode).toBe(0)
    expect(v4.questions).toEqual([{ name: "www.example.com", type: TYPE_A }])
    expect(v4.answers).toEqual([
      {
        name: "www.example.com",
        type: TYPE_CNAME,
        ttl: 60,
        data: "edge.example.net",
      },
      {
        name: "edge.example.net",
        type: TYPE_A,
        ttl: 30,
        data: "93.184.216.34",
      },
    ])
    expect(v6.answers[1]).toEqual({
      name: "edge.example.net",
      type: TYPE_AAAA,
      ttl: 30,
      data: "2606:2800:220:1::1",
    })
  })

  it("follows compression pointers backwards only", () => {
    // Header, then a question for "a.b", then an answer whose name points
    // at the question's name (offset 12).
    const header = Buffer.from("000081800001000100000000", "hex")
    const question = Buffer.from("01610162000001" + "0001", "hex")
    const answer = Buffer.from("c00c000100010000003c00045db8d822", "hex")
    const message = decodeMessage(Buffer.concat([header, question, answer]))

    expect(message.answers).toEqual([
      { name: "a.b", type: TYPE_A, ttl: 60, data: "93.184.216.34" },
    ])

    // A pointer to itself would loop: refused.
    const looping = Buffer.from("c01c000100010000003c00045db8d822", "hex")
    expect(() =>
      decodeMessage(Buffer.concat([header, question, looping])),
    ).toThrow(/points forward/)
  })

  it("refuses an answer that ends too early, or a query", () => {
    const full = answerFor(
      { "a.b": { a: ["1.2.3.4"] } },
      { name: "a.b", type: TYPE_A },
    )

    expect(() => decodeMessage(full.subarray(0, full.length - 2))).toThrow(
      DnsWireError,
    )
    expect(() => decodeMessage(encodeQuery("a.b", TYPE_A))).toThrow(/a query/)
  })

  it("reads no such name as rcode 3", () => {
    const message = decodeMessage(
      answerFor({}, { name: "gone.example", type: TYPE_A }),
    )
    expect(message.rcode).toBe(3)
    expect(message.answers).toEqual([])
  })
})

describe("followChain", () => {
  const answers = [
    {
      name: "www.example.com",
      type: TYPE_CNAME,
      ttl: 600,
      data: "edge.example.net",
    },
    { name: "edge.example.net", type: TYPE_A, ttl: 30, data: "93.184.216.34" },
    // Not on the chain: an address for a name nobody asked about.
    { name: "bank.example", type: TYPE_A, ttl: 30, data: "10.0.0.1" },
  ]

  it("takes the addresses at the end of the chain, with its shortest TTL", () => {
    expect(followChain(answers, "WWW.example.com", TYPE_A)).toEqual({
      addresses: ["93.184.216.34"],
      name: "edge.example.net",
      ttl: 30,
    })
  })

  it("says where a chain stops without addresses", () => {
    expect(followChain(answers.slice(0, 1), "www.example.com", TYPE_A)).toEqual(
      {
        addresses: [],
        name: "edge.example.net",
        ttl: 600,
      },
    )
  })

  it("refuses a loop", () => {
    expect(() =>
      followChain(
        [
          { name: "a.example", type: TYPE_CNAME, ttl: 1, data: "b.example" },
          { name: "b.example", type: TYPE_CNAME, ttl: 1, data: "a.example" },
        ],
        "a.example",
        TYPE_A,
      ),
    ).toThrow(/loop/)
  })
})
