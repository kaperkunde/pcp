import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { fileName, fileTar, firstTarEntry, TarError } from "./files"

const FILES = { volume: "data", path: "/data" }

describe("a name in a service's files folder", () => {
  it.each([
    ["report.pdf", "/data/report.pdf"],
    ["in/report 2026 (final).pdf", "/data/in/report 2026 (final).pdf"],
    ["/data/out/report.txt", "/data/out/report.txt"],
    [".hidden", "/data/.hidden"],
  ])("takes %j as %s", (given, full) => {
    expect(fileName(FILES, given).path).toBe(full)
  })

  it("takes a full path relative to a folder inside the volume", () => {
    expect(
      fileName({ volume: "data", path: "/data/in/" }, "/data/in/a.pdf"),
    ).toEqual({ relative: "a.pdf", path: "/data/in/a.pdf" })
  })

  it.each([
    "../etc/passwd",
    "in/../../x",
    "./a",
    "/etc/passwd",
    "/data",
    "/data/",
    "/database/x",
    "a//b",
    "a/",
    " a",
    "a ",
    "a;b",
    "a$(b)",
    "a\nb",
    "a:b",
    "naïve.pdf",
    "",
    "x".repeat(101),
    `${"a/".repeat(100)}b`,
  ])("refuses %j", (given) => {
    expect(() => fileName(FILES, given)).toThrow()
  })
})

describe("the tar stream", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pcp-tar-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("is read by the machine's own tar as one file, folders made", () => {
    const bytes = Buffer.from("%PDF-1.7 a document\n")
    const name = `${"long-folder-name/".repeat(5)}${"n".repeat(90)}.pdf`
    const out = path.join(dir, "out")
    mkdirSync(out)
    const result = spawnSync("tar", ["-x", "-f", "-", "-C", out], {
      input: fileTar(name, bytes),
    })

    expect(result.status, String(result.stderr)).toBe(0)
    expect(readFileSync(path.join(out, name))).toEqual(bytes)
    // And PCP reads its own stream back.
    expect(firstTarEntry(fileTar(name, bytes))).toEqual({
      name,
      type: "file",
      size: bytes.length,
      data: bytes,
    })
  })

  it("reads what the machine's own tar writes: a file, a folder, a link", () => {
    writeFileSync(path.join(dir, "a.txt"), "hello")
    mkdirSync(path.join(dir, "sub"))
    spawnSync("ln", ["-s", "/etc/passwd", path.join(dir, "link")])
    const tar = (name: string) =>
      spawnSync("tar", ["-c", "-f", "-", "-C", dir, name]).stdout as Buffer

    expect(firstTarEntry(tar("a.txt"))).toMatchObject({
      name: "a.txt",
      type: "file",
      size: 5,
      data: Buffer.from("hello"),
    })
    expect(firstTarEntry(tar("sub"))?.type).toBe("folder")
    expect(firstTarEntry(tar("link"))?.type).toBe("link")
    // Only the start of a file's stream: what it is, without its bytes.
    const big = Buffer.alloc(100_000, 7)
    writeFileSync(path.join(dir, "big.bin"), big)
    expect(firstTarEntry(tar("big.bin").subarray(0, 8192))).toMatchObject({
      type: "file",
      size: 100_000,
      data: null,
    })
  })

  it("reads a pax header's long name", () => {
    const name = "p".repeat(150)
    writeFileSync(path.join(dir, name), "x")
    const stream = spawnSync("tar", [
      "--format=pax",
      "-c",
      "-f",
      "-",
      "-C",
      dir,
      name,
    ]).stdout as Buffer

    expect(firstTarEntry(stream)).toMatchObject({ name, type: "file", size: 1 })
  })

  it("is empty, or refused when it is not a tar stream", () => {
    expect(firstTarEntry(Buffer.alloc(0))).toBeNull()
    expect(firstTarEntry(Buffer.alloc(1024))).toBeNull()
    const broken = fileTar("a", Buffer.from("x"))
    broken[0] = 0x62
    expect(() => firstTarEntry(broken)).toThrow(TarError)
    expect(() => firstTarEntry(Buffer.from("not a tar"))).toThrow(TarError)
  })
})
