import { describe, expect, it } from "vitest"

import { domUnseen, formLike, NOTHING_UNSEEN, unseenLine } from "./unseen"

// What snapshot, find and read_page say their tree leaves out. The probe
// itself runs against a real Chromium in call.test.ts; here, what it reads
// of DevTools' document and the line it makes.

describe("what the tree leaves out", () => {
  it("counts closed shadow roots with something in them, and canvases, through frames and open roots", () => {
    const element = (nodeName: string, more = {}) => ({
      nodeId: Math.floor(Math.random() * 1e6),
      nodeType: 1,
      nodeName,
      ...more,
    })
    const root = element("HTML", {
      children: [
        element("BODY", {
          children: [
            element("DIV", {
              shadowRoots: [
                {
                  nodeId: 2,
                  nodeType: 11,
                  nodeName: "#document-fragment",
                  shadowRootType: "closed",
                  children: [element("FORM")],
                },
              ],
            }),
            element("DIV", {
              shadowRoots: [
                {
                  nodeId: 3,
                  nodeType: 11,
                  nodeName: "#document-fragment",
                  shadowRootType: "closed",
                  children: [],
                },
              ],
            }),
            element("INPUT", {
              shadowRoots: [
                {
                  nodeId: 4,
                  nodeType: 11,
                  nodeName: "#document-fragment",
                  shadowRootType: "user-agent",
                  children: [element("DIV")],
                },
              ],
            }),
            element("IFRAME", {
              contentDocument: element("HTML", {
                children: [element("CANVAS", { nodeId: 9 })],
              }),
            }),
          ],
        }),
      ],
    })

    expect(domUnseen(root)).toEqual({ closedShadowRoots: 1, canvases: [9] })
  })

  it("says so in one line, refs and an OCR route included, and nothing when there is nothing", () => {
    expect(unseenLine(NOTHING_UNSEEN, "x")).toBeNull()
    expect(
      unseenLine(
        {
          frames: [
            { ref: "e3", crossOrigin: true },
            { ref: "e8", crossOrigin: true },
            { ref: null, crossOrigin: false },
          ],
          closedShadowRoots: 1,
          canvases: 2,
        },
        "pass its handle to ocr/read",
      ),
    ).toBe(
      "2 cross-origin iframes (refs e3, e8), 1 iframe, 1 closed shadow root and 2 canvases not included: the page shows more than this. Take a screenshot to see them (view_image with crop shows you part of it closer) and OCR it to read their text (pass its handle to ocr/read); click with a point (x, y) from the screenshot reaches into them.",
    )
  })

  it("tells a find for part of a form from one for anything else", () => {
    expect(formLike("Email")).toBe(true)
    expect(formLike("sign up")).toBe(true)
    expect(formLike("Submit")).toBe(true)
    expect(formLike("Pricing")).toBe(false)
  })
})
