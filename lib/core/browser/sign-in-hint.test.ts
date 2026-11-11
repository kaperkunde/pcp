import { describe, expect, it } from "vitest"

import type { SiteSignIn } from "../browser-secrets"
import { signInLine } from "./sign-in-hint"

// The note of the owner's sign-ins at a page's site, in words: names and
// what the owner said of each, never a value; louder at a password field.
// Against a real page: browser/secrets.test.ts.

const SHOP = "https://shop.example"

const password: SiteSignIn = {
  name: "Shop password",
  kind: "text",
  loginName: "ada@example.com",
  note: "The family account",
  totp: "Shop code",
}

describe("the sign-in note", () => {
  it("is none where the owner keeps no sign-in", () => {
    expect(signInLine(SHOP, [], true)).toBeNull()
  })

  it("names each sign-in with its login name, one-time codes and note", () => {
    const hint = signInLine(
      SHOP,
      [
        password,
        {
          name: "Spare",
          kind: "text",
          loginName: null,
          note: null,
          totp: null,
        },
        {
          name: "Old code",
          kind: "totp",
          loginName: null,
          note: null,
          totp: null,
        },
      ],
      false,
    )

    expect(hint?.loud).toBe(false)
    expect(hint?.line).toBe(
      `Sign-ins the owner keeps for ${SHOP}: "Shop password" (login: ada@example.com, one-time codes: "Shop code", note: The family account); "Spare"; "Old code" (one-time codes). To sign in, type one with type's text {"$secret": "Shop password"}; you never see its value.`,
    )
  })

  it("says so first at a page with a password field", () => {
    const hint = signInLine(SHOP, [password], true)

    expect(hint?.loud).toBe(true)
    expect(hint?.line).toMatch(/^This page has a password field/)
    expect(hint?.line).toContain('{"$secret": "Shop password"}')
    expect(hint?.line).toContain("Do not ask the owner for it")
    // Its login name is typed through PCP too, as one credential.
    expect(hint?.line).toContain(
      'Type the login name with {"$secret": "Shop password", "part": "username"}',
    )
    expect(
      signInLine(SHOP, [{ ...password, loginName: null }], true)?.line,
    ).toContain("Type the login name as plain text")
  })
})
