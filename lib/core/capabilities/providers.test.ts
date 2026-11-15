import { describe, expect, it } from "vitest"

import { capabilitiesNamed, itemOfImage } from "./list"
import {
  findProviders,
  hasProvider,
  optionPath,
  type CandidateTool,
} from "./providers"
import { runProvider, type Bridge } from "./run"

// Providers are found by words and by the shape of their arguments, never
// by a vendor's name: these are the tools Docling's API endpoint and the
// PDF MCP Server publish, as PCP reads them, and a few that look alike.

const FILE = {
  type: "object",
  properties: {
    $result: { type: "string" },
    name: { type: "string" },
    type: { type: "string" },
  },
  required: ["$result"],
  additionalProperties: false,
}

function tool(
  server: string,
  name: string,
  description: string,
  schema: unknown,
  more: Partial<CandidateTool> = {},
): CandidateTool {
  return {
    serverId: `id-${server}`,
    server,
    tool: name,
    description,
    access: "allowed",
    tier: "write",
    schema,
    ...more,
  }
}

/** An API endpoint like Docling's: a multipart upload of files. */
const docling = [
  tool(
    "docling",
    "process_file_v1_convert_file_post",
    "Process File. Convert documents from files.",
    {
      type: "object",
      properties: {
        body: {
          type: "object",
          properties: {
            files: { type: "array", items: FILE },
            to_formats: {
              type: "array",
              items: { enum: ["md", "json", "html", "text"] },
            },
            do_ocr: { type: "boolean" },
            force_ocr: { type: "boolean" },
            image_export_mode: {
              enum: ["placeholder", "embedded", "referenced"],
            },
          },
          required: ["files"],
        },
      },
      required: ["body"],
    },
  ),
  tool(
    "docling",
    "process_file_async_v1_convert_file_async_post",
    "Process File Async. Convert documents from files, as a task.",
    {
      type: "object",
      properties: {
        body: {
          type: "object",
          properties: {
            files: { type: "array", items: FILE },
            do_ocr: { type: "boolean" },
          },
        },
      },
    },
  ),
]

const path = (description = "Path to the PDF file") => ({
  type: "string",
  description,
})

/** A service's own put_file and get_file (services/tools.ts), as published. */
const SERVICE_PUT = {
  type: "object",
  properties: {
    file: {
      type: "object",
      properties: { $result: { type: "string" } },
      required: ["$result"],
      additionalProperties: false,
    },
    path: { type: "string" },
    overwrite: { type: "boolean" },
  },
  required: ["file", "path"],
  additionalProperties: false,
}
const SERVICE_GET = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
}

/** An MCP server like the PDF MCP Server: files in its own folder. */
const pdfServer = [
  tool("pdf", "put_file", "Save a file into the data folder.", {
    type: "object",
    properties: {
      file_path: path(),
      content_base64: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["file_path", "content_base64"],
  }),
  tool("pdf", "get_file", "Get a file from the data folder.", {
    type: "object",
    properties: { file_path: path() },
    required: ["file_path"],
  }),
  tool(
    "pdf",
    "extract_text",
    "Unified text extraction. engine: auto tries native, then OCR with Tesseract.",
    {
      type: "object",
      properties: {
        pdf_path: path(),
        engine: { type: "string" },
        include_confidence: { type: "boolean" },
      },
      required: ["pdf_path"],
    },
  ),
  tool(
    "pdf",
    "export_pdf",
    "Export PDF content to Markdown. dpi: resolution for OCR.",
    {
      type: "object",
      properties: { pdf_path: path(), output_path: path() },
      required: ["pdf_path", "output_path"],
    },
  ),
  tool("pdf", "get_ocr_languages", "Get available OCR languages.", {
    type: "object",
    properties: {},
  }),
  tool(
    "pdf",
    "get_pdf_form_fields",
    "Return available form fields in the PDF.",
    {
      type: "object",
      properties: { pdf_path: path() },
      required: ["pdf_path"],
    },
  ),
  tool(
    "pdf",
    "fill_pdf_form",
    "Fill a PDF form with provided data. Optionally flatten.",
    {
      type: "object",
      properties: {
        input_path: path(),
        output_path: path(),
        data: { type: "object" },
        flatten: { type: "boolean" },
      },
      required: ["input_path", "output_path", "data"],
    },
  ),
  tool(
    "pdf",
    "fill_pdf_form_any",
    "Fill standard or non-standard forms using label detection.",
    {
      type: "object",
      properties: {
        input_path: path(),
        output_path: path(),
        data: { type: "object" },
      },
      required: ["input_path", "output_path", "data"],
    },
  ),
  tool("pdf", "flatten_pdf", "Flatten a PDF (remove form fields).", {
    type: "object",
    properties: { input_path: path(), output_path: path() },
    required: ["input_path", "output_path"],
  }),
  tool("pdf", "merge_pdfs", "Merge multiple PDFs into a single file.", {
    type: "object",
    properties: {
      pdf_list: { type: "array", items: { type: "string" } },
      output_path: path(),
    },
    required: ["pdf_list", "output_path"],
  }),
  tool(
    "pdf",
    "add_signature_image",
    "Add a signature image to one page or several.",
    {
      type: "object",
      properties: {
        input_path: path(),
        output_path: path(),
        image_path: path("The signature image"),
        page: { anyOf: [{ type: "integer" }, { type: "null" }] },
        rect: { anyOf: [{ type: "array" }, { type: "null" }] },
      },
      required: ["input_path", "output_path"],
    },
  ),
]

describe("finding providers", () => {
  it("finds an API endpoint that takes files by handle, for reading and converting, and not its async twin", () => {
    const read = findProviders("read", docling)
    const convert = findProviders("convert", docling)

    expect(read.map((found) => found.tool.tool)).toEqual([
      "process_file_v1_convert_file_post",
    ])
    expect(read[0]!.input).toEqual({
      kind: "handle",
      path: ["body", "files"],
      many: true,
    })
    expect(read[0]!.step).toBeNull()
    expect(convert[0]!.tool.tool).toBe("process_file_v1_convert_file_post")
    expect(
      optionPath(read[0]!, {
        names: ["force_ocr"],
        type: "boolean",
      }),
    ).toEqual(["body", "force_ocr"])
    expect(
      optionPath(convert[0]!, {
        names: ["to_formats"],
        type: "array",
        item: "md",
      }),
    ).toEqual(["body", "to_formats"])
    // An enum without the value leaves the option out.
    expect(
      optionPath(convert[0]!, {
        names: ["to_formats"],
        type: "array",
        item: "docx",
      }),
    ).toBeNull()
  })

  it("finds a server's tools on paths through its file step, and the right tool for each operation", () => {
    const read = findProviders("read", pdfServer)

    expect(read).toHaveLength(1)
    expect(read[0]!.tool.tool).toBe("extract_text")
    expect(read[0]!.input).toEqual({
      kind: "path",
      path: ["pdf_path"],
      many: false,
    })
    expect(read[0]!.pdfOnly).toBe(true)
    expect(read[0]!.step).toEqual({
      kind: "mcp",
      server: "pdf",
      put: "put_file",
      get: "get_file",
      overwrite: true,
    })

    expect(findProviders("form_fields", pdfServer)[0]!.tool.tool).toBe(
      "get_pdf_form_fields",
    )
    const fill = findProviders("fill_form", pdfServer)[0]!
    expect(fill.tool.tool).toBe("fill_pdf_form")
    expect(fill.output).toEqual(["output_path"])
    expect(findProviders("flatten", pdfServer)[0]!.tool.tool).toBe(
      "flatten_pdf",
    )
    const merge = findProviders("merge", pdfServer)[0]!
    expect(merge.tool.tool).toBe("merge_pdfs")
    expect(merge.input).toEqual({
      kind: "path",
      path: ["pdf_list"],
      many: true,
    })
    const sign = findProviders("sign", pdfServer)[0]!
    expect(sign.tool.tool).toBe("add_signature_image")
    expect(sign.input.path).toEqual(["input_path"])
    expect(sign.image?.path).toEqual(["image_path"])
  })

  it("leaves out tools on paths where the server has no file step", () => {
    const noStep = pdfServer.filter(
      (entry) => entry.tool !== "put_file" && entry.tool !== "get_file",
    )

    expect(findProviders("read", noStep)).toEqual([])
    expect(hasProvider("pdf_edit", noStep)).toBe(false)
  })

  it("takes a file step by its shape, never by the names alone", () => {
    // Only the #92 tools: their shape makes the step.
    expect(findProviders("read", pdfServer)[0]!.step?.kind).toBe("mcp")

    // Tools by those names that take something else are no step, and no
    // provider either.
    const otherShape = [
      ...pdfServer.filter(
        (entry) => entry.tool !== "put_file" && entry.tool !== "get_file",
      ),
      tool("pdf", "put_file", "Save a file with a text body.", {
        type: "object",
        properties: { name: { type: "string" }, text: { type: "string" } },
        required: ["name", "text"],
      }),
      tool("pdf", "get_file", "Get a file's text.", {
        type: "object",
        properties: { file_path: path() },
        required: ["file_path"],
      }),
    ]

    expect(findProviders("read", otherShape)).toEqual([])
    expect(hasProvider("pdf_edit", otherShape)).toBe(false)
  })

  it("prefers the file step of the service with a files folder that registered the server", () => {
    const service = [
      tool(
        "pdf-service",
        "put_file",
        "Puts a kept file into the service in its files folder.",
        SERVICE_PUT,
        { serverId: "id-pdf-service", kind: "service" },
      ),
      tool(
        "pdf-service",
        "get_file",
        "Gets one file the service keeps in its files folder.",
        SERVICE_GET,
        { serverId: "id-pdf-service", kind: "service" },
      ),
    ]
    const services = new Map([["id-pdf", "id-pdf-service"]])

    const read = findProviders(
      "read",
      [...pdfServer, ...service],
      undefined,
      services,
    )
    expect(read.map((entry) => entry.tool.tool)).toEqual(["extract_text"])
    expect(read[0]!.step).toEqual({
      kind: "service",
      server: "pdf-service",
      put: "put_file",
      get: "get_file",
      overwrite: true,
    })

    // The service's tools of their own are no provider: without the
    // server it registered, there is none.
    expect(findProviders("read", service, undefined, services)).toEqual([])
    expect(hasProvider("pdf_edit", service, undefined, services)).toBe(false)

    // A service the token cannot use the file tools of: the server's own.
    expect(
      findProviders("read", pdfServer, undefined, services)[0]!.step?.kind,
    ).toBe("mcp")

    // Not registered by that service: its tools are not this server's step.
    expect(
      findProviders("read", [...pdfServer, ...service])[0]!.step?.kind,
    ).toBe("mcp")

    // Same-named tools on a service that are not the family's shape.
    const odd = service.map((entry) => ({
      ...entry,
      schema: { type: "object", properties: { name: { type: "string" } } },
    }))
    expect(
      findProviders("read", [...pdfServer, ...odd], undefined, services)[0]!
        .step?.kind,
    ).toBe("mcp")
  })

  it("leaves out a tool with a required argument the operation has nothing for", () => {
    const tools = [
      tool("ocr", "ocr_image", "OCR an image.", {
        type: "object",
        properties: {
          image_base64: { type: "string" },
          region: { type: "string" },
        },
        required: ["image_base64", "region"],
      }),
    ]

    expect(findProviders("read", tools)).toEqual([])
  })

  it("takes a tool that takes base64, one per server, the one allowed and launched from a common item ranked first", () => {
    const tools = [
      tool("ocr-one", "ocr_image", "OCR an image.", {
        type: "object",
        properties: { image_base64: { type: "string" } },
        required: ["image_base64"],
      }),
      tool(
        "ocr-two",
        "recognize",
        "Text recognition (OCR) of a picture.",
        {
          type: "object",
          properties: { image_base64: { type: "string" } },
          required: ["image_base64"],
        },
        { access: "ask" },
      ),
      ...docling,
    ]
    const found = findProviders(
      "read",
      tools,
      new Map([["id-docling", "docling"]]),
    )

    expect(found.map((entry) => entry.tool.server)).toEqual([
      "docling",
      "ocr-one",
      "ocr-two",
    ])
    expect(found[1]!.input).toEqual({ kind: "base64", path: ["image_base64"] })
    expect(found[0]!.item).toBe("docling")
  })
})

describe("running a provider through a service's file step", () => {
  it("puts the file's handle in the service's files folder, gives the tools the path it answered, and gets what they wrote", async () => {
    const services = new Map([["id-pdf", "id-pdf-service"]])
    const tools = [
      ...pdfServer,
      tool("pdf-service", "put_file", "Puts a kept file.", SERVICE_PUT, {
        serverId: "id-pdf-service",
        kind: "service",
      }),
      tool("pdf-service", "get_file", "Gets one file.", SERVICE_GET, {
        serverId: "id-pdf-service",
        kind: "service",
      }),
    ]
    const flatten = findProviders("flatten", tools, undefined, services)[0]!
    const calls: Parameters<Bridge>[0][] = []
    const bridge: Bridge = async (call) => {
      calls.push(call)

      if (call.tool === "put_file") {
        return { ok: true, value: { path: `/data/${String(call.args.path)}` } }
      }

      if (call.tool === "get_file") {
        return {
          ok: true,
          value: { path: call.args.path, result: { $result: "r-out" } },
        }
      }

      return { ok: true, value: { ok: true } }
    }

    const run = await runProvider(
      flatten,
      {
        main: [{ id: "r-in", name: "form.pdf", mediaType: "application/pdf" }],
      },
      {},
      bridge,
    )

    expect(run).toEqual({
      ok: true,
      value: { ok: true },
      files: [{ $result: "r-out" }],
    })
    const [put, edit, get] = calls
    expect(put).toEqual({
      server: "pdf-service",
      tool: "put_file",
      args: {
        file: { $result: "r-in" },
        path: expect.stringMatching(/^pcp\/[0-9a-f]{16}\/form\.pdf$/),
        overwrite: true,
      },
    })
    // No base64 through the MCP server: its tool gets the path put_file
    // answered, and writes beside it.
    const placed = `/data/${String(put!.args.path)}`
    expect(edit).toEqual({
      server: "pdf",
      tool: "flatten_pdf",
      args: {
        input_path: placed,
        output_path: placed.replace(/form\.pdf$/, "flatten.pdf"),
      },
    })
    expect(get).toEqual({
      server: "pdf-service",
      tool: "get_file",
      args: { path: edit!.args.output_path },
    })
    expect(calls).toHaveLength(3)
  })

  it("stops when the service's put_file does not say where it put the file", async () => {
    const services = new Map([["id-pdf", "id-pdf-service"]])
    const tools = [
      ...pdfServer,
      tool("pdf-service", "put_file", "Puts a kept file.", SERVICE_PUT, {
        serverId: "id-pdf-service",
        kind: "service",
      }),
      tool("pdf-service", "get_file", "Gets one file.", SERVICE_GET, {
        serverId: "id-pdf-service",
        kind: "service",
      }),
    ]
    const read = findProviders("read", tools, undefined, services)[0]!
    const bridge: Bridge = async () => ({ ok: true, value: { done: true } })

    expect(
      await runProvider(
        read,
        { main: [{ id: "r-in", name: "a.pdf", mediaType: "application/pdf" }] },
        {},
        bridge,
      ),
    ).toEqual({
      ok: false,
      error: "pdf-service/put_file did not answer where it put the file.",
    })
  })
})

describe("the capability list", () => {
  it("names capabilities by a query's words, and items by an image", () => {
    expect(capabilitiesNamed("ocr a meter photo").map((c) => c.id)).toEqual([
      "read_image",
    ])
    expect(capabilitiesNamed("fill in a PDF form").map((c) => c.id)).toEqual([
      "pdf_edit",
    ])
    expect(
      capabilitiesNamed("convert a docx to markdown").map((c) => c.id),
    ).toEqual(["convert_document"])
    expect(capabilitiesNamed("send an email")).toEqual([])
    expect(
      itemOfImage("ghcr.io/docling-project/docling-serve-cpu@sha256:aa")?.name,
    ).toBe("docling")
    expect(itemOfImage("ghcr.io/kaperkunde/pdf-mcp-server:latest")?.name).toBe(
      "pdf-mcp-server",
    )
    expect(itemOfImage("docker.io/library/nginx")).toBeNull()
  })
})

describe("a PDF's page as a picture", () => {
  const PATH = { type: "string" }
  const renderer = (name: string, description: string) =>
    tool("pages", name, description, {
      type: "object",
      properties: { file: FILE, page: { type: "integer" } },
      required: ["file"],
    })

  it("is a tool that renders a page to an image, by its words", () => {
    for (const [name, description] of [
      ["render_page", "Render one page of a PDF."],
      ["pdf_to_image", "Turn a PDF into pictures."],
      ["convert", "Converts the pages of a PDF to PNG images."],
    ] as const) {
      const found = findProviders("page_image", [renderer(name, description)])
      expect(
        found.map((each) => each.tool.tool),
        name,
      ).toEqual([name])
    }
  })

  it("is not one that pulls images out, makes a PDF of them, or reads text", () => {
    for (const [name, description] of [
      ["extract_images", "Extract embedded images from PDF pages."],
      ["images_to_pdf", "Make a PDF of images, one per page."],
      ["get_image_info", "Information about images in a PDF."],
      ["add_signature_image", "Add a signature image on a page."],
      ["extract_text", "Text of each page of a PDF."],
    ] as const) {
      expect(
        findProviders("page_image", [renderer(name, description)]),
        name,
      ).toEqual([])
    }
  })

  it("on paths, puts the PDF in place and fetches the PNG it wrote", () => {
    const own = [
      ...pdfServer.filter((each) =>
        ["put_file", "get_file"].includes(each.tool),
      ),
      tool("pdf", "render_page", "Render a PDF page as an image.", {
        type: "object",
        properties: {
          pdf_path: PATH,
          output_path: PATH,
          page_number: { type: "integer" },
        },
        required: ["pdf_path", "output_path", "page_number"],
      }),
    ]

    const [found] = findProviders("page_image", own)

    expect(found).toMatchObject({
      input: { kind: "path", path: ["pdf_path"] },
      output: ["output_path"],
      step: { kind: "mcp", put: "put_file", get: "get_file" },
    })
  })
})
