import { existsSync, readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scratchDatabase } from "../test-db"
import { buildCommit, buildDate, PCP_BUILT_AT, PCP_COMMIT } from "../version"
import { installSignalFile } from "./host-signal"
import {
  installHost,
  installNewest,
  installWay,
  type InstallHost,
} from "./install"
import { checkNow, setUpdateChannel, setUpdateFetch } from "./runtime"
import { getUpdateStatus } from "./state"

// One answer for the owner's "Install and restart" and for update_pcp:
// whether this PCP installs an update itself, and how.

const HOST: InstallHost = {
  kind: "container",
  desktopUpdater: "manual",
  hostUpdater: false,
  hostUpdaterFollowsChannel: false,
  autoUpdated: false,
}

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  setUpdateFetch()
  await cleanup()
})

function answer(tag: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ tag_name: tag, body: "notes", assets: [] }), {
      status: 200,
    })) as unknown as typeof fetch
}

describe("installHost", () => {
  it("reads how PCP was installed from what its host set", () => {
    expect(installHost({})).toEqual({
      kind: "source",
      desktopUpdater: "manual",
      hostUpdater: false,
      hostUpdaterFollowsChannel: false,
      autoUpdated: false,
    })
    expect(
      installHost({ PCP_DESKTOP: "1", PCP_DESKTOP_UPDATER: "auto" }),
    ).toMatchObject({ kind: "desktop", desktopUpdater: "auto" })
    expect(
      installHost({ PCP_CONTAINER: "1", PCP_HOST_UPDATER: "2" }),
    ).toMatchObject({
      kind: "container",
      hostUpdater: true,
      hostUpdaterFollowsChannel: true,
    })
    expect(installHost({ PCP_HOST_UPDATER: "yes" }).hostUpdater).toBe(false)
  })
})

describe("installWay", () => {
  it("lets the desktop app's own updater and the Linux installer install", () => {
    expect(
      installWay(
        { ...HOST, kind: "desktop", desktopUpdater: "auto" },
        "stable",
      ),
    ).toEqual({ can: true, via: "desktop", signalHost: false })
    expect(installWay({ ...HOST, hostUpdater: true }, "stable")).toEqual({
      can: true,
      via: "installer",
      signalHost: true,
    })
    expect(
      installWay(
        { ...HOST, hostUpdater: true, hostUpdaterFollowsChannel: true },
        "develop",
      ),
    ).toMatchObject({ can: true, signalChannel: "develop" })
  })

  it("says why not, and the owner's steps, everywhere else", () => {
    const manual = installWay({ ...HOST, kind: "desktop" }, "stable")
    expect(manual).toMatchObject({ can: false, reason: "desktop_manual" })
    expect(!manual.can && manual.steps).toContain(
      "Download the new version for this computer",
    )

    const container = installWay(HOST, "develop")
    expect(container).toMatchObject({
      can: false,
      reason: "container",
      message:
        "This PCP cannot install updates itself. Follow the steps under How to update this PCP.",
    })
    expect(!container.can && container.steps).toContain(
      "PCP_TAG=develop docker compose pull",
    )

    const auto = installWay({ ...HOST, autoUpdated: true }, "stable")
    expect(!auto.can && auto.steps).toContain("This PCP updates itself")

    const source = installWay({ ...HOST, kind: "source" }, "stable")
    expect(source).toMatchObject({ can: false, reason: "source" })
    expect(!source.can && source.steps).toContain("git switch main && git pull")

    const releasesOnly = installWay({ ...HOST, hostUpdater: true }, "develop")
    expect(releasesOnly).toMatchObject({
      can: false,
      reason: "installer_releases_only",
    })
    expect(!releasesOnly.can && releasesOnly.steps).toContain(
      "PCP_CHANNEL=develop sh",
    )
  })
})

describe("installNewest", () => {
  it("refuses where this PCP cannot install, before anything is written", async () => {
    setUpdateFetch(answer("v999.0.0"))
    await checkNow()

    await expect(installNewest(HOST)).rejects.toThrow(
      "This PCP cannot install updates itself.",
    )
    expect((await getUpdateStatus()).installRequest).toBeUndefined()
  })

  it("refuses develop for an installer that installs releases only", async () => {
    await setUpdateChannel("develop")

    await expect(installNewest({ ...HOST, hostUpdater: true })).rejects.toThrow(
      /installs releases only/,
    )
  })

  it("leaves the request for the installer, and says what happens", async () => {
    setUpdateFetch(answer("v999.0.0"))
    await checkNow()

    const installed = await installNewest({ ...HOST, hostUpdater: true })

    expect(installed).toMatchObject({ version: "999.0.0", via: "installer" })
    expect(installed.message).toMatch(/^PCP is installing v999\.0\.0/)
    expect(existsSync(installSignalFile())).toBe(true)
    expect(readFileSync(installSignalFile(), "utf8")).toContain(
      (await getUpdateStatus()).installRequest!.id,
    )
  })
})

describe("the build's commit and date", () => {
  it("are taken only as a commit and a date", () => {
    expect(buildCommit(" 0123456789ABCDEF0123456789abcdef01234567 ")).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    )
    expect(buildCommit("abc1234")).toBe("abc1234")
    expect(buildCommit("abc")).toBeNull()
    expect(buildCommit("main")).toBeNull()
    expect(buildCommit("")).toBeNull()
    expect(buildCommit(undefined)).toBeNull()

    expect(buildDate("2026-11-20T10:00:00Z")).toBe("2026-11-20T10:00:00.000Z")
    expect(buildDate("yesterday")).toBeNull()
    expect(buildDate("")).toBeNull()
    expect(buildDate(undefined)).toBeNull()
  })

  it("are read from PCP_COMMIT and PCP_BUILT_AT, unknown where nobody set them", () => {
    expect(PCP_COMMIT).toBe(buildCommit(process.env.PCP_COMMIT))
    expect(PCP_BUILT_AT).toBe(buildDate(process.env.PCP_BUILT_AT))
  })
})
