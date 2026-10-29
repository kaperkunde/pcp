import YAML from "yaml"

import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createEndpoint } from "../endpoints"
import { createSecret, writeManagedSecret } from "../secrets"
import { ensureDefinition } from "../definition-rows"
import { createServer, setToolDescription } from "../servers"
import {
  parseServiceDefinition,
  serviceDefinitionHash,
  type ServiceDefinitionInput,
} from "../services/definition"
import { createSshServer } from "../ssh/hosts"
import { createSkill, saveSkillFile } from "../skills"
import { saveWrapperByOwner } from "../wrappers/admin"
import { asBytes, encryptString } from "../crypto"
import { newId } from "../ids"

import { encryptItemData } from "./store"

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

/**
 * A linked repository and one linked skill, written as rows without asking
 * GitHub: for the export and vault-deletion tests, which read no repository.
 */
export async function addLinkedRepo(
  ctx: VaultContext,
  { skillId, secretId = null }: { skillId: string; secretId?: string | null },
): Promise<{ repoId: string; itemId: string }> {
  const repoId = newId()
  const itemId = newId()

  await db().repo.create({
    data: {
      id: repoId,
      vaultId: ctx.vaultId,
      ciphertext: asBytes(
        encryptString(
          ctx.dek,
          JSON.stringify({ owner: "ada", name: "shared", branch: "main" }),
          `repo:${repoId}`,
        ),
      ),
      trust: "trusted",
      access: "write",
      secretId,
    },
  })
  await db().repoItem.create({
    data: {
      id: itemId,
      repoId,
      itemKind: "skill",
      skillId,
      ciphertext: encryptItemData(ctx, itemId, {
        path: "skills/release-notes",
        remoteSha: "a".repeat(40),
        localHash: "b".repeat(64),
        pending: null,
        declinedSha: null,
        drafts: {},
        note: null,
      }),
      frequency: "weekly",
      bidirectional: true,
      lastSyncAt: new Date("2026-10-01T00:00:00.000Z"),
    },
  })

  return { repoId, itemId }
}

export const SERVICE_DIGEST = `sha256:${"c".repeat(64)}`

/** Docling, as a service's definition: an API endpoint behind a key. */
export const DOCLING: ServiceDefinitionInput = {
  image: `ghcr.io/docling-project/docling-serve-cpu@${SERVICE_DIGEST}`,
  source: "ghcr.io/docling-project/docling-serve-cpu:latest",
  ports: [{ container: 5001 }],
  env: [
    {
      name: "DOCLING_SERVE_API_KEY",
      required: true,
      description: "The key every request sends in X-Api-Key.",
    },
    { name: "DOCLING_SERVE_ENABLE_UI", value: "false" },
  ],
  health: { kind: "http", port: 5001, path: "/health" },
  registers: {
    kind: "openapi",
    port: 5001,
    specPath: "/openapi.json",
    auth: {
      env: "DOCLING_SERVE_API_KEY",
      header: "X-Api-Key",
      template: "{{secret}}",
    },
  },
}

/**
 * A service the owner launched, as rows only (nothing connects): on their
 * SSH server build.ada-home.net, published on its address 192.168.7.20, its
 * key in the secret "Docling key", and the API endpoint it registered.
 */
export async function addService(
  ctx: VaultContext,
  definition: ServiceDefinitionInput = DOCLING,
): Promise<{ id: string; hostId: string; registeredId: string }> {
  const { id: hostId } = await createSshServer(ctx, {
    name: "Build box",
    host: "build.ada-home.net",
    port: 22,
    username: "deploy",
  })
  const key = await createSecret(ctx, {
    name: "Docling key",
    value: "dk-SERVICE-KEY-31415",
  })
  const { id: registeredId } = await createServer(ctx, {
    name: "Docling",
    url: "http://192.168.7.20:5001/mcp",
    authType: "none",
  })
  const checked = parseServiceDefinition(definition)
  const id = newId()

  await db().mcpServer.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      kind: "service",
      name: "Docling service",
      slug: "docling-service",
      description: "Turns PDFs and images into Markdown.",
      url: "pcp:service",
      authType: "none",
      serviceSpec: {
        create: {
          definition: JSON.stringify(checked),
          hash: serviceDefinitionHash(checked),
          hostId,
          engine: "docker",
          engineVersion: "27.1.1",
          containerName: "pcp-docling",
          publish: JSON.stringify({
            address: "192.168.7.20",
            ports: [{ container: 5001, host: 5001 }],
          }),
          env: JSON.stringify({ DOCLING_SERVE_API_KEY: key.id }),
          registeredId,
        },
      },
    },
  })
  await ensureDefinition(id)

  return { id, hostId, registeredId }
}
