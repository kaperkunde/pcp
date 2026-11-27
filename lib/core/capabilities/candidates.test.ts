import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import type { GatewayServer } from "../gateway-servers"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { candidateTools } from "./candidates"
import { MAX_SCHEMAS_READ } from "./limits"
import { mightProvide } from "./providers"

function server(id: string, tools: { name: string; description: string }[]) {
  return {
    id,
    slug: id,
    kind: "endpoint",
    tools: tools.map((tool, n) => ({
      id: `${id}-${n}`,
      name: tool.name,
      title: null,
      description: tool.description,
      descriptionOverride: null,
      access: "allowed",
      tier: "write",
    })),
  } as unknown as GatewayServer
}

describe("mightProvide", () => {
  it("takes a tool by its name or words for the capability, and leaves others", () => {
    expect(
      mightProvide("generate_image", {
        tool: "create_image",
        description: "Generate an image",
      }),
    ).toBe(true)
    expect(
      mightProvide("generate_image", {
        tool: "read_file",
        description: "Read a file's text",
      }),
    ).toBe(false)
    expect(
      mightProvide("generate_image", {
        tool: "list_images",
        description: "List the images",
      }),
    ).toBe(false)
  })
})

describe("candidateTools", () => {
  let cleanup: () => Promise<void>
  let ctx: VaultContext

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  it("reads a capability's likely providers first, so many other tools never crowd one out", async () => {
    const filler = server(
      "files",
      Array.from({ length: MAX_SCHEMAS_READ + 20 }, (_, n) => ({
        name: `read_file_${n}`,
        description: "Read a file's text from the page",
      })),
    )
    const images = server("openai-images", [
      { name: "create_image", description: "Generate an image" },
    ])

    const without = await candidateTools(ctx, [filler, images])
    expect(without.some((tool) => tool.tool === "create_image")).toBe(false)

    const tools = await candidateTools(ctx, [filler, images], "generate_image")
    expect(tools).toHaveLength(MAX_SCHEMAS_READ)
    expect(tools[0]).toMatchObject({
      server: "openai-images",
      tool: "create_image",
    })
  })
})
