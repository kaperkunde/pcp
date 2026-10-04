// The package's own types declare a module named "domino", not the name it
// is published under, so TypeScript finds nothing for the import. Only the
// one function lib/core/fetch/html.ts uses.
declare module "@mixmark-io/domino" {
  const domino: {
    /** Parses a whole HTML document, as a browser would. */
    createDocument(html?: string, force?: boolean): Document
  }

  export default domino
}
