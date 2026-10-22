import YAML from "yaml"

import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createEndpoint } from "../endpoints"
import { createSecret, writeManagedSecret } from "../secrets"
import { createServer, setToolDescription } from "../servers"
import { createSkill, saveSkillFile } from "../skills"
import { saveWrapperByOwner } from "../wrappers/admin"

/**
 * A vault with one of every shareable kind, for the repository tests: its
 * secrets hold values that must never reach a file.
 */

export const PETS_KEY = "sk-live-PETS-0123456789abcdef"
export const CLIENT_SECRET = "cs-CLIENT-fedcba9876543210"
export const OAUTH_TOKEN = "at-OAUTH-TOKEN-5555"
export const REFRESH_TOKEN = "rt-OAUTH-REFRESH-7777"

export const PETS_SPEC = JSON.stringify(
  {
    openapi: "3.0.3",
    info: { title: "Pets", version: "1" },
    servers: [{ url: "https://pets.example.com/v1" }],
    paths: {
      "/pets": {
        get: {
          operationId: "list_pets",
          summary: "Lists the pets",
          parameters: [
            { name: "key", in: "query", schema: { type: "string" } },
            { name: "kind", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
        post: {
          operationId: "add_pet",
          summary: "Adds a pet",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  },
  null,
  2,
)

export const NOTES_SPEC = `openapi: 3.0.3
info:
  title: Notes
  version: "1"
servers:
  - url: https://notes.example.com/api
components:
  securitySchemes:
    oauth:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://notes.example.com/authorize
          tokenUrl: https://notes.example.com/token
          scopes:
            notes.read: Read notes
paths:
  /notes:
    get:
      operationId: list_notes
      security:
        - oauth: [notes.read]
      responses:
        "200":
          description: ok
`

export const ANTHROPIC_SKILL = `---
name: pdf-tools
description: Comprehensive PDF manipulation toolkit for extracting text and tables. Use when working with PDF files.
license: Proprietary. LICENSE.txt has complete terms
allowed-tools: Bash, Read
compatibility: claude-code
metadata:
  author: someone
  tags:
    - pdf
    - documents
---

# PDF tools

Read reference.md first.
`

export type Fixture = {
  ids: {
    skill: string
    pets: string
    notes: string
    docs: string
    calendar: string
    wrapper: string
    flow: string
  }
}

/** The secrets every vault in these tests holds, by name. */
export async function addSecrets(
  ctx: VaultContext,
  values: { pets?: string; client?: string } = {},
): Promise<{ pets: string; client: string }> {
  const pets = await createSecret(ctx, {
    name: "Pets key",
    value: values.pets ?? PETS_KEY,
  })
  const client = await createSecret(ctx, {
    name: "Notes client secret",
    value: values.client ?? CLIENT_SECRET,
  })

  return { pets: pets.id, client: client.id }
}

/** One item of every kind, the way the owner would make them. */
export async function populate(ctx: VaultContext): Promise<Fixture> {
  const secrets = await addSecrets(ctx)
  await createBrowserServer(ctx)

  const { id: skill } = await createSkill(ctx, {
    name: "release-notes",
    description: "Write the release notes for a version.",
    body: "1. List the merged pull requests.\n2. Write what changed, and why.",
    tools: ["github/list_pull_requests"],
    extra: { license: "MIT", metadata: { owner: "Ada" } },
  })
  await saveSkillFile(ctx, skill, {
    path: "reference/style.md",
    text: "Short sentences.\nNo jargon.",
  })

  const { id: pets } = await createEndpoint(ctx, {
    name: "Pets",
    description: "The pet shop's API.",
    baseUrl: "https://pets.example.com/v1",
    specSource: "upload",
    specText: PETS_SPEC,
    patches: [
      {
        op: "replace",
        path: "/paths/~1pets/get/summary",
        value: "Lists every pet in the shop",
      },
    ],
    readOnly: false,
    publicOnly: true,
    authType: "header",
    authHeaderName: "X-Api-Key",
    authValueTemplate: "{{secret}}",
    authSecretId: secrets.pets,
  })
  await setToolDescription(ctx, pets, "add_pet", "Adds one pet, by name.")

  const { id: notes } = await createEndpoint(ctx, {
    name: "Notes",
    description: "Notes, over OAuth.",
    baseUrl: "https://notes.example.com/api",
    specSource: "upload",
    specText: NOTES_SPEC,
    readOnly: true,
    authType: "oauth",
    oauthClientId: "notes-client",
    oauthClientSecretId: secrets.client,
  })

  const { id: docs } = await createServer(ctx, {
    name: "Docs",
    description: "The team's documents.",
    url: "https://docs.example.com/mcp",
    authType: "header",
    authHeaderName: "Authorization",
    authValueTemplate: "Bearer {{secret}}",
    authSecretId: secrets.pets,
    authExtraHeaders: [
      {
        secretId: secrets.client,
        headerName: "X-Client",
        valueTemplate: "{{secret}}",
      },
    ],
    publicOnly: true,
  })

  const { id: calendar } = await createServer(ctx, {
    name: "Calendar Hub",
    url: "https://calendar.example.com/mcp",
    authType: "oauth",
    oauthScope: "calendar",
  })
  const tokens = await writeManagedSecret(ctx, {
    name: "Calendar Hub OAuth",
    description: "PCP's sign-in.",
    value: JSON.stringify({
      tokens: { access_token: OAUTH_TOKEN, refresh_token: REFRESH_TOKEN },
    }),
  })
  await db().mcpServer.update({
    where: { id: calendar },
    data: { oauthTokensId: tokens.id, oauthConnectedAt: new Date() },
  })

  const { id: wrapper } = await saveWrapperByOwner(ctx, null, {
    name: "Pet tools",
    description: "Pets, simpler.",
    tools: [
      {
        name: "dogs",
        title: "Dogs",
        description: "Lists the dogs.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        program:
          'const answer = await pcp.call("pets/list_pets", { key: { $secret: "Pets key" }, kind: "dog" })\nreturn answer',
        calls: ["pets/list_pets"],
        replaces: ["pets/list_pets"],
      },
      {
        name: "add",
        description: "Adds a pet.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        program: 'return await pcp.call("pets/add_pet", {})',
        calls: ["pets/add_pet"],
      },
    ],
    secrets: [{ secret: "Pets key", tool: "pets/list_pets", argument: "/key" }],
  })

  const { id: flow } = await saveWrapperByOwner(ctx, null, {
    name: "Open the shop",
    description: "Opens the pet shop's page.",
    callLevels: "token",
    tools: [
      {
        name: "open",
        description: "Opens the shop.",
        inputSchema: { type: "object" },
        program:
          'return await pcp.call("browser/navigate", { url: "https://pets.example.com/" })',
        calls: ["browser/navigate"],
      },
    ],
  })

  return { ids: { skill, pets, notes, docs, calendar, wrapper, flow } }
}

/** A YAML document as text, for hand-made repository files. */
export function yamlText(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 })
}
