import { expect, test } from "@playwright/test"

import { callTool, toolText } from "../lib/mcp"
import {
  acceptNextDialog,
  addSecret,
  clickHydrated,
  createToken,
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
