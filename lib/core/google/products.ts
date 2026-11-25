/**
 * The Google Workspace products PCP can connect through one Google sign-in
 * (lib/core/google/): each is one of Google's own MCP servers, with the
 * scopes it needs. Static and pure; a product's address is a fact about
 * Google's servers, the one place it is written.
 *
 * The scopes are the narrowest that make the server's tools work, from each
 * server's own published list (its protected-resource metadata at
 * /.well-known/oauth-protected-resource/mcp/v1): reading mail, drafting but
 * not sending it, writing only the Drive files PCP made or the owner opened
 * with it (drive.file), and reading the rest.
 */

export const GOOGLE_PRODUCT_IDS = [
  "gmail",
  "calendar",
  "search",
  "drive",
  "docs",
  "sheets",
  "slides",
  "tasks",
  "people",
  "chat",
  "classroom",
] as const

export type GoogleProductId = (typeof GOOGLE_PRODUCT_IDS)[number]

const AUTH = "https://www.googleapis.com/auth/"

export type GoogleProduct = {
  id: GoogleProductId
  /** The server's name in PCP. */
  name: string
  /** Its short name, as an assistant names it in tool calls. */
  slug: string
  /** Google's MCP server for it (Streamable HTTP). */
  url: string
  /** What an assistant is told the server is for. */
  description: string
  /** The scopes it asks for, whole addresses. */
  scopes: readonly string[]
  /** What the owner reads on the page: what it lets an assistant do. */
  allows: string
  /** Ticked when the owner has not chosen yet. */
  defaultOn: boolean
}

function scopes(...names: string[]): string[] {
  return names.map((name) => `${AUTH}${name}`)
}

export const GOOGLE_PRODUCTS: readonly GoogleProduct[] = [
  {
    id: "gmail",
    name: "Google Gmail",
    slug: "google-gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    description:
      "Your Gmail: search and read mail, and write drafts and organise labels. It cannot send mail.",
    scopes: scopes("gmail.readonly", "gmail.compose", "gmail.modify"),
    allows:
      "Read and search your mail, write drafts, and label and archive mail. It cannot send mail.",
    defaultOn: true,
  },
  {
    id: "calendar",
    name: "Google Calendar",
    slug: "google-calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    description:
      "Your Google Calendar: list your calendars and read, create and change events.",
    scopes: scopes("calendar.calendarlist.readonly", "calendar.events"),
    allows: "See your calendars, and read, add, change and delete events.",
    defaultOn: true,
  },
  {
    id: "search",
    name: "Google Workspace search",
    slug: "google-search",
    url: "https://workspacemcp.googleapis.com/mcp/v1",
    description:
      "Search across your Gmail, Drive and Calendar at once, read only.",
    scopes: scopes("gmail.readonly", "drive.readonly", "calendar.readonly"),
    allows: "Search and read across your mail, Drive files and calendar.",
    defaultOn: true,
  },
  {
    id: "drive",
    name: "Google Drive",
    slug: "google-drive",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    description:
      "Your Google Drive: find and read files, and create and change the files PCP makes or you open with it.",
    scopes: scopes("drive.readonly", "drive.file"),
    allows:
      "Find and read all your files, and write only files PCP created or you opened with it.",
    defaultOn: true,
  },
  {
    id: "docs",
    name: "Google Docs",
    slug: "google-docs",
    url: "https://docsmcp.googleapis.com/mcp/v1",
    description: "Your Google Docs: read documents and edit them.",
    scopes: scopes("documents", "drive.readonly"),
    allows: "Read and edit your documents.",
    defaultOn: true,
  },
  {
    id: "sheets",
    name: "Google Sheets",
    slug: "google-sheets",
    url: "https://sheetsmcp.googleapis.com/mcp/v1",
    description: "Your Google Sheets: read spreadsheets and edit them.",
    scopes: scopes("spreadsheets", "drive.readonly"),
    allows: "Read and edit your spreadsheets.",
    defaultOn: true,
  },
  {
    id: "slides",
    name: "Google Slides",
    slug: "google-slides",
    url: "https://slidesmcp.googleapis.com/mcp/v1",
    description: "Your Google Slides: read presentations and edit them.",
    scopes: scopes("presentations", "drive.readonly"),
    allows: "Read and edit your presentations.",
    defaultOn: true,
  },
  {
    id: "tasks",
    name: "Google Tasks",
    slug: "google-tasks",
    url: "https://tasksmcp.googleapis.com/mcp/v1",
    description: "Your Google Tasks: lists and tasks, read and changed.",
    scopes: scopes("tasks"),
    allows: "Read, add, change and complete your tasks.",
    defaultOn: true,
  },
  {
    id: "people",
    name: "Google People",
    slug: "google-people",
    url: "https://people.googleapis.com/mcp/v1",
    description:
      "Your Google contacts and your organisation's directory, read only.",
    scopes: scopes(
      "contacts.readonly",
      "directory.readonly",
      "userinfo.profile",
    ),
    allows:
      "Read your contacts, your organisation's directory and your profile.",
    defaultOn: true,
  },
  {
    id: "chat",
    name: "Google Chat",
    slug: "google-chat",
    url: "https://chatmcp.googleapis.com/mcp/v1",
    description: "Your Google Chat: spaces, members and messages, read only.",
    scopes: scopes(
      "chat.spaces.readonly",
      "chat.memberships.readonly",
      "chat.messages.readonly",
    ),
    allows: "Read your Chat spaces, their members and messages.",
    defaultOn: false,
  },
  {
    id: "classroom",
    name: "Google Classroom",
    slug: "google-classroom",
    url: "https://classroommcp.googleapis.com/mcp/v1",
    description:
      "Your Google Classroom: courses, announcements, rosters and coursework, read only.",
    scopes: scopes(
      "classroom.courses.readonly",
      "classroom.announcements.readonly",
      "classroom.rosters.readonly",
      "classroom.coursework.students.readonly",
      "classroom.topics.readonly",
    ),
    allows: "Read your courses, announcements, class lists and coursework.",
    defaultOn: false,
  },
]

/**
 * What every sign-in also asks for, so the page can say which Google account
 * PCP is signed in as: the account's email address. Nothing else.
 */
export const GOOGLE_IDENTITY_SCOPES: readonly string[] = ["openid", "email"]

export function isGoogleProductId(value: string): value is GoogleProductId {
  return (GOOGLE_PRODUCT_IDS as readonly string[]).includes(value)
}

export function googleProduct(id: string): GoogleProduct | undefined {
  return GOOGLE_PRODUCTS.find((product) => product.id === id)
}

/** The products ticked when the owner has not chosen. */
export function defaultGoogleProducts(): GoogleProductId[] {
  return GOOGLE_PRODUCTS.filter((product) => product.defaultOn).map(
    (product) => product.id,
  )
}

/** The scopes of these products together, once each, in a stable order. */
export function scopesOf(products: readonly string[]): string[] {
  const wanted = new Set<string>()

  for (const product of GOOGLE_PRODUCTS) {
    if (products.includes(product.id)) {
      for (const scope of product.scopes) {
        wanted.add(scope)
      }
    }
  }

  return [...wanted]
}

/** The products among these whose every scope is among `granted`. */
export function coveredProducts(
  products: readonly string[],
  granted: readonly string[],
): GoogleProductId[] {
  const has = new Set(granted)

  return GOOGLE_PRODUCTS.filter(
    (product) =>
      products.includes(product.id) &&
      product.scopes.every((scope) => has.has(scope)),
  ).map((product) => product.id)
}
