import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { expect, test } from "@playwright/test"

import { startFakeDocker } from "../../lib/core/services/fake-docker"
import { startFakeSsh } from "../../lib/core/ssh/fake-server"
import { callTool, toolText } from "../lib/mcp"
import {
  acceptNextDialog,
  addSecret,
  clickHydrated,
  createToken,
  openMoreOptions,
} from "../lib/ui"

// The secret store from the owner's side: a value is hidden until the owner
// asks for it, and the secret can be renamed, rotated, given the sign-in it
// belongs to and deleted.
const RUN = Date.now().toString(36)
const NAME = `Postcard key ${RUN}`

test("a secret is hidden until revealed, refuses a duplicate name, and can be rotated, renamed and deleted", async ({
  page,
}) => {
  await addSecret(page, {
    name: NAME,
    value: "pk_live_hunter2",
    description: "For the postcard service",
  })

  const row = page.getByRole("listitem").filter({ hasText: NAME })
  await expect(row.getByText("For the postcard service")).toBeVisible()
  // The value is not on the page until asked for.
  await expect(page.getByText("pk_live_hunter2")).toHaveCount(0)

  await row.getByRole("button", { name: "Reveal" }).click()
  await expect(row.getByText("pk_live_hunter2")).toBeVisible()
  await row.getByRole("button", { name: "Hide" }).click()
  await expect(row.getByText("pk_live_hunter2")).toHaveCount(0)

  // A second secret under the same name is refused, and the sheet stays open.
  await clickHydrated(page.getByRole("button", { name: "Add a secret" }))
  const dialog = page.getByRole("dialog", { name: "Add a secret" })
  await dialog.getByLabel("Name", { exact: true }).fill(NAME)
  await dialog.getByLabel("Value").fill("another")
  await dialog.getByRole("button", { name: "Save secret" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(/already exists/)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()

  await row.getByRole("button", { name: "Edit" }).click()
  await row.getByLabel("Name", { exact: true }).fill(`${NAME} v2`)
  await row.getByLabel("New value").fill("pk_live_rotated")
  // The sign-in it belongs to: what assistants see beside its name.
  await row.getByLabel("Login name").fill("ada@example.com")
  await row.getByLabel("Note", { exact: true }).fill("The family account")
  await row.getByRole("button", { name: "Save" }).click()

  const renamed = page.getByRole("listitem").filter({ hasText: `${NAME} v2` })
  await expect(renamed).toBeVisible()
  await expect(
    renamed.getByText("Login: ada@example.com · The family account"),
  ).toBeVisible()
  await renamed.getByRole("button", { name: "Reveal" }).click()
  await expect(renamed.getByText("pk_live_rotated")).toBeVisible()

  acceptNextDialog(page)
  await renamed.getByRole("button", { name: "Delete" }).click()
  await expect(renamed).toHaveCount(0)
})

test("a one-time codes secret takes only a seed, shows its code of the moment, and keeps its sites for the browser", async ({
  page,
}) => {
  const name = `Shop codes ${RUN}`
  await page.goto("/secrets")
  await clickHydrated(page.getByRole("button", { name: "Add a secret" }))
  const dialog = page.getByRole("dialog", { name: "Add a secret" })
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  await dialog.getByLabel("Kind").selectOption("totp")
  await dialog.getByLabel("Seed").fill("not a seed!")
  await dialog.getByRole("button", { name: "Save secret" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(/base32/)
  // A refused save keeps what was typed and chosen.
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(name)
  await expect(dialog.getByLabel("Kind")).toHaveValue("totp")

  // RFC 6238's seed, "12345678901234567890" in base32.
  await dialog.getByLabel("Seed").fill("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
  await dialog
    .getByLabel("Sites for the browser (optional)")
    .fill("https://shop.example/login")
  await dialog.getByRole("button", { name: "Save secret" }).click()
  await expect(dialog).toBeHidden()

  const row = page.getByRole("listitem").filter({ hasText: name })
  await expect(row.getByText("One-time codes")).toBeVisible()
  await expect(row.getByText("Browser: 1 site")).toBeVisible()

  await row.getByRole("button", { name: "Code", exact: true }).click()
  await expect(row.getByText(/^\d{6}$/)).toBeVisible()

  await row.getByRole("button", { name: "Browser", exact: true }).click()
  await expect(
    row.getByText("https://shop.example", { exact: true }),
  ).toBeVisible()
  await row.getByRole("button", { name: "Remove" }).click()
  await expect(row.getByText("No sites yet.")).toBeVisible()

  // A site with its subdomains, within its own domain.
  await row.getByLabel("Add a site").fill("waternet.nl")
  await row.getByRole("checkbox", { name: /And its subdomains/ }).check()
  await row.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    row.getByText("https://waternet.nl", { exact: true }),
  ).toBeVisible()
  // Exact: the checkbox's own label starts "And its subdomains" too.
  await expect(
    row.getByText("and its subdomains", { exact: true }),
  ).toBeVisible()

  acceptNextDialog(page)
  await row.getByRole("button", { name: "Delete" }).click()
  await expect(row).toHaveCount(0)
})

test("a new secret an assistant proposes is made by PCP on the owner's page, and its value never reaches the assistant", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, `Secret maker ${RUN}`)
  const proposed = `Made key API ${RUN}`
  const secretName = `Made key ${RUN}`

  // An API the assistant proposes, its new key made by PCP (#162).
  const asked = await callTool(baseURL!, token, "register_server", {
    name: proposed,
    openapi_schema: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Made key", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: { "/things": { get: { operationId: "listThings" } } },
    }),
    url: "https://api.example.com/v1",
    auth_type: "header",
    header_name: "X-Api-Key",
    value_template: "{{secret}}",
    secret: secretName,
    generate: { format: "hex", length: 40 },
  })
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  // The assistant asked for it, so the switch starts on, with its recipe.
  const make = page.getByRole("switch", { name: /^Have PCP make it/ })
  await expect(make).toBeChecked()
  await expect(page.getByLabel("Kind")).toHaveValue("hex")
  await expect(page.getByLabel("Length")).toHaveValue("40")
  await expect(
    page.getByLabel(`Value of the secret "${secretName}"`),
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Added ${proposed}`,
  )

  // It is under Secrets, and its value is what PCP made.
  await page.goto("/secrets")
  const row = page.getByRole("listitem").filter({ hasText: secretName })
  await expect(row.getByText(proposed, { exact: true })).toBeVisible()
  await row.getByRole("button", { name: "Reveal" }).click()
  const value = (await row.getByText(/^[0-9a-f]{40}$/).textContent())?.trim()
  expect(value).toMatch(/^[0-9a-f]{40}$/)

  // The assistant learns that PCP made it, never what it is.
  const outcome = toolText(
    await callTool(baseURL!, token, "check_permission", { id }),
  )
  expect(outcome).toContain(
    `PCP made the value of the new secret "${secretName}"`,
  )
  expect(outcome).not.toContain(value!)
})

test("an assistant proposes a new value PCP makes, and the service that uses the secret is made again with it", async ({
  page,
  baseURL,
}) => {
  const host = `Rotate box ${RUN}`
  const service = `Rotated ${RUN}`
  const secretName = `Rotated key ${RUN}`
  const oldValue = `sk-old-${RUN}`
  // A fake engine behind a test SSH server (as services.spec.ts), and the
  // service's health answered here, reached through the SSH connection.
  const docker = startFakeDocker()
  let authorized: string | null = null
  const ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
    allowForwarding: true,
  })
  const http = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as AddressInfo).port

  try {
    await page.goto("/servers/ssh/new")
    await page.getByLabel("Name", { exact: true }).fill(host)
    await page.getByLabel("Host", { exact: true }).fill("127.0.0.1")
    await page.getByLabel("Login").fill("deploy")
    await openMoreOptions(page)
    await page.getByLabel("Port").fill(String(ssh.port))
    await page.getByRole("button", { name: "Add SSH server" }).click()
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
    authorized = (await page.getByTestId("ssh-public-key").textContent())!
    await page.getByRole("button", { name: "Check sign-in" }).click()
    await expect(
      page.getByRole("status").filter({ hasText: "PCP signed in." }),
    ).toBeVisible()

    await addSecret(page, { name: secretName, value: oldValue })

    await page.goto("/servers/services/new")
    await page.getByLabel("Name", { exact: true }).fill(service)
    await page
      .getByLabel("SSH server", { exact: true })
      .selectOption({ label: `${host} (127.0.0.1)` })
    await page.getByLabel("Definition").fill(
      JSON.stringify({
        image: `ghcr.io/example/rotated@sha256:${"a".repeat(64)}`,
        ports: [{ container: 5001 }],
        env: [{ name: "API_KEY", required: true }],
        health: { kind: "http", port: 5001, path: "/health" },
      }),
    )
    await page.getByLabel("The SSH server's port for 5001").fill(String(port))
    await page.getByLabel("API_KEY").selectOption({ label: secretName })
    await page.getByRole("button", { name: "Launch" }).click()
    await expect(page.getByTestId("service-card")).toContainText(
      "Running and healthy",
    )
    const container = `pcp-${service.toLowerCase().replace(/\s+/g, "-")}`
    const envOf = () =>
      Object.entries(docker.state().containers).find(([name]) =>
        name.startsWith(container),
      )?.[1]?.env
    expect(envOf()).toBe(`API_KEY=${oldValue}\n`)

    // The assistant proposes a new value, made by PCP (#162).
    const token = await createToken(page, `Rotator ${RUN}`)
    const asked = await callTool(baseURL!, token, "rotate_secret", {
      name: secretName,
      reason: "The old key leaked.",
      generate: { format: "alphanumeric", length: 40 },
    })
    expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
    const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
    expect(id, toolText(asked)).toBeTruthy()

    await page.goto(`/permissions/${id}`)
    const review = page.getByTestId("secret-change-review")
    await expect(review).toContainText("Gets the new value")
    await expect(review).toContainText(service)
    await expect(
      page.getByRole("switch", { name: /^Have PCP make it/ }),
    ).toBeChecked()
    await expect(page.getByLabel("Length")).toHaveValue("40")
    await page.getByRole("button", { name: "Save the new value" }).click()
    await expect(page.getByTestId("permission-outcome")).toContainText(
      "Made again with it: 1 of 1 services.",
    )

    // The service was made again with the value PCP made, which the owner
    // can reveal and the assistant never gets.
    await page.goto("/secrets")
    const row = page.getByRole("listitem").filter({ hasText: secretName })
    await row.getByRole("button", { name: "Reveal" }).click()
    const value = (
      await row.getByText(/^[A-Za-z0-9]{40}$/).textContent()
    )?.trim()
    expect(value).toMatch(/^[A-Za-z0-9]{40}$/)
    expect(envOf()).toBe(`API_KEY=${value}\n`)
    expect(JSON.stringify(docker.commands)).not.toContain(value!)

    const outcome = toolText(
      await callTool(baseURL!, token, "check_permission", { id }),
    )
    expect(outcome).toContain("that PCP made itself")
    expect(outcome).not.toContain(value!)
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await ssh.close()
    docker.close()
  }
})
