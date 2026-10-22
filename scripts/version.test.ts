import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import { bump, devBuild, leadsDevelop, nextRelease } from "./version.mjs"

describe("nextRelease", () => {
  it("releases the package version when nothing has been released", () => {
    expect(nextRelease("0.1.0", [])).toBe("0.1.0")
  })

  it("raises the patch of the latest release", () => {
    expect(nextRelease("0.1.0", ["v0.1.0"])).toBe("0.1.1")
    expect(nextRelease("0.1.0", ["v0.1.0", "v0.1.1", "v0.1.2"])).toBe("0.1.3")
  })

  it("orders releases by number, not by text", () => {
    expect(nextRelease("0.1.0", ["v0.1.10", "v0.1.9", "v0.1.2"])).toBe("0.1.11")
  })

  it("releases a manual bump as written", () => {
    expect(nextRelease("0.2.0", ["v0.1.0", "v0.1.4"])).toBe("0.2.0")
    expect(nextRelease("1.0.0", ["v0.9.12"])).toBe("1.0.0")
  })

  it("continues from the bump once it is released", () => {
    expect(nextRelease("0.2.0", ["v0.1.4", "v0.2.0"])).toBe("0.2.1")
  })

  it("ignores tags that are not releases", () => {
    expect(
      nextRelease("0.1.0", ["v0.1.0", "v2", "v9.9.9-rc.1", "latest", "1.0.0"]),
    ).toBe("0.1.1")
  })

  it("ignores develop's builds", () => {
    expect(nextRelease("0.1.0", ["v0.1.0", "v0.1.1-dev.7"])).toBe("0.1.1")
  })

  it("refuses a package version that is not MAJOR.MINOR.PATCH", () => {
    expect(() => nextRelease("0.1.0.0", [])).toThrow()
  })
})

describe("devBuild", () => {
  it("is the next release with the build's number", () => {
    expect(devBuild("0.4.2", ["v0.4.1", "v0.4.2"], "57")).toBe("0.4.3-dev.57")
    expect(devBuild("0.5.0", ["v0.4.2", "v0.4.3-dev.57"], "58")).toBe(
      "0.5.0-dev.58",
    )
  })

  it("refuses a build number that is not one", () => {
    for (const run of ["", "0", "07", "1.2", "x", "1234567890"]) {
      expect(() => devBuild("0.4.2", [], run)).toThrow()
    }
  })
})

describe("leadsDevelop", () => {
  it("is a release later than every build of develop", () => {
    // 0.4.3-dev.1 was the only build when 0.4.3 was released: the develop
    // channel's latest is 0.4.3, and its image tag has to say so.
    expect(leadsDevelop("0.4.3", ["v0.4.2", "v0.4.3-dev.1", "v0.4.3"])).toBe(
      true,
    )
    expect(leadsDevelop("0.4.4", ["v0.4.3", "v0.4.4-dev.12"])).toBe(true)
    expect(leadsDevelop("0.4.4", ["v0.4.3-dev.9", "v0.4.4-dev.10"])).toBe(true)
    expect(leadsDevelop("0.1.0", [])).toBe(true)
  })

  it("is not when develop is already building a later release", () => {
    // A MINOR bump on develop that main has not merged yet.
    expect(leadsDevelop("0.4.4", ["v0.4.4-dev.12", "v0.5.0-dev.13"])).toBe(
      false,
    )
    expect(leadsDevelop("0.4.4", ["v0.4.5-dev.1"])).toBe(false)
  })

  it("ignores tags that are not builds of develop", () => {
    expect(
      leadsDevelop("0.4.4", ["v9.9.9-rc.1", "9.9.9-dev.1", "v9.9-dev.1"]),
    ).toBe(true)
  })

  it("refuses a version that is not a release", () => {
    expect(() => leadsDevelop("0.4.4-dev.1", [])).toThrow()
  })
})

// The develop channel installs the image's `develop` tag (install.sh,
// docker-compose.yaml with PCP_TAG=develop), and PCP's update check on that
// channel offers the latest version among the releases and develop's builds
// (lib/core/updates/release.ts). So a release that is later than every build
// moves the `develop` tag too; otherwise the channel is offered the release
// and pulls the build it already runs, until develop is pushed again.
describe("the develop tag", () => {
  type Workflow = {
    on: { workflow_call?: { inputs: Record<string, { type: string }> } }
    jobs: Record<
      string,
      {
        outputs?: Record<string, string>
        with?: Record<string, unknown>
        steps?: { id?: string; run?: string; with?: { tags?: string } }[]
      }
    >
  }
  const workflow = (name: string) =>
    parse(
      readFileSync(
        path.resolve(__dirname, "..", ".github", "workflows", name),
        "utf8",
      ),
    ) as Workflow

  it("moves with a release that leads develop's builds", () => {
    const release = workflow("release.yml")
    const step = release.jobs.release!.steps!.find((s) =>
      s.run?.includes("scripts/version.mjs leads"),
    )

    expect(step?.id).toBeTruthy()
    expect(release.jobs.release!.outputs?.develop).toContain(
      `steps.${step!.id}.outputs`,
    )
    expect(release.jobs.image!.with).toMatchObject({
      "channel-tag": "latest",
      "develop-tag": "${{ needs.release.outputs.develop == 'true' }}",
    })
  })

  it("is pushed for both images when asked, beside the channel's", () => {
    const images = workflow("build-images.yml")

    expect(images.on.workflow_call?.inputs["develop-tag"]?.type).toBe("boolean")
    const tags = images.jobs
      .image!.steps!.map((s) => s.with?.tags)
      .filter(Boolean)
    expect(tags).toHaveLength(2)
    for (const list of tags) {
      expect(list).toContain(":${{ inputs.channel-tag }}")
      expect(list).toMatch(/inputs\.develop-tag && .*:develop/)
    }
  })

  it("is the channel's own tag for a build of develop", () => {
    const develop = workflow("develop.yml")

    expect(develop.jobs.image!.with).toMatchObject({
      "channel-tag": "develop",
    })
    expect(develop.jobs.image!.with?.["develop-tag"]).toBeUndefined()
  })
})

describe("bump", () => {
  it("raises minor and resets patch", () => {
    expect(bump("0.1.7", "minor")).toBe("0.2.0")
  })

  it("raises major and resets the rest", () => {
    expect(bump("0.4.3", "major")).toBe("1.0.0")
  })

  it("leaves patch to the release workflow", () => {
    expect(() => bump("0.1.0", "patch")).toThrow(/release workflow/)
    expect(() => bump("0.1.0", "huge")).toThrow()
  })
})
