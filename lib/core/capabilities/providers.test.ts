import { describe, expect, it } from "vitest"

import { capabilitiesNamed, itemOfImage } from "./list"
import {
  findProviders,
  hasProvider,
  optionPath,
  type CandidateTool,
} from "./providers"

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
