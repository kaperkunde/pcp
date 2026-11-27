import { describe, expect, it } from "vitest"

import {
  isProgramTool,
  parseBuiltinTools,
  PROGRAM_TOOL_NAMES,
  PROGRAM_TOOLS,
  storeBuiltinTools,
} from "./program-tools"

describe("the built-in tools a program may call", () => {
  it("is exactly this list, the data tools: no admin or owner tool among them", () => {
    expect([...PROGRAM_TOOL_NAMES]).toEqual([
      "web_search",
      "web_fetch",
      "read_image",
      "convert_document",
      "edit_pdf",
      "generate_image",
      "list_folder",
      "find_files",
      "get_file",
      "save_file",
      "make_folder",
      "move",
    ])

    for (const admin of [
      "register_server",
      "propose_tool_access",
      "propose_server_limits",
      "update_endpoint",
      "get_endpoint",
      "create_wrapper",
      "update_wrapper",
      "delete_wrapper",
      "request_secret",
      "edit_secret",
      "rotate_secret",
      "change_secret_scope",
      "delete_secret",
      "list_secrets",
      "memory",
      "read_memory",
      "update_pcp",
      "check_permission",
      "withdraw_request",
      "share_file",
      "share_result",
      "receive_file",
      "create_upload_link",
      "read_result",
      "delete",
    ]) {
      expect(isProgramTool(admin), admin).toBe(false)
    }
  })

  it("has words for each box, and no tool twice", () => {
    expect(new Set(PROGRAM_TOOL_NAMES).size).toBe(PROGRAM_TOOLS.length)

    for (const tool of PROGRAM_TOOLS) {
      expect(tool.label, tool.name).not.toBe("")
      expect(tool.caption, tool.name).toMatch(/\.$/)
    }
  })

  it("reads a stored choice as the eligible names only, each once, in order", () => {
    expect(parseBuiltinTools("[]")).toEqual([])
    expect(parseBuiltinTools("not json")).toEqual([])
    expect(parseBuiltinTools({})).toEqual([])
    expect(
      parseBuiltinTools(
        JSON.stringify(["move", "register_server", "web_search", "move", 4]),
      ),
    ).toEqual(["web_search", "move"])
    expect(storeBuiltinTools(["web_fetch", "memory"])).toBe('["web_fetch"]')
  })
})
