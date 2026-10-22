import { expect, test } from "@playwright/test"

import { startGitHub, type FakeGitHub } from "../fixtures/github"
import { clickHydrated, openRequestFromBell } from "../lib/ui"

// Linked repositories against the fake GitHub (e2e/fixtures/github.ts): the
// owner links a public repository from Settings, adds a skill from it after
// reading every file, and a later change from it waits for them in the bell
// (the repository is not trusted) until they read it and approve it.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const OWNER = "e2e"
const NAME = `shared-${RUN}`
const SKILL = `e2e-${RUN}-notes`

function skillMd(description: string): string {
  return `---\nname: ${SKILL}\ndescription: ${description}\n---\n\nWrite it down.\n`
}

let github: FakeGitHub

test.beforeAll(async () => {
  github = await startGitHub()
  github.addRepo(OWNER, NAME, {
    files: {
      "README.md": "Skills we share.",
      [`skills/${SKILL}/SKILL.md`]: skillMd(`Take notes (${RUN}).`),
    },
  })
})

test.afterAll(async () => {
  await github?.close()
})

test("the owner links a repository from Settings", async ({ page }) => {
  await page.goto("/settings")
  await page.getByRole("link", { name: /Repositories/ }).click()
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible()

  await page.getByRole("button", { name: "Add a repository" }).click()
  const dialog = page.getByRole("dialog", { name: "Add a repository" })
  await dialog
    .getByLabel("Repository", { exact: true })
    .fill(`${OWNER}/${NAME}`)
  // Trusting it says what that lets the repository do.
  await dialog.getByRole("radio", { name: "Trusted", exact: true }).check()
  await expect(dialog.getByText(/prompt injection/)).toBeVisible()
  await dialog.getByRole("radio", { name: "Not trusted", exact: true }).check()
  await dialog.getByRole("button", { name: "Add repository" }).click()

  await expect(
    page.getByRole("heading", { name: `${OWNER}/${NAME}` }),
  ).toBeVisible()
  await expect(page.getByText(/someone else's repository/)).toBeVisible()
})

test("adds a skill from it after reading every file", async ({ page }) => {
  await page.goto("/settings/repositories")
  await page.getByRole("link", { name: new RegExp(NAME) }).click()
  await page.getByRole("link", { name: "Add items from it" }).click()

  await page.getByRole("checkbox", { name: new RegExp(SKILL) }).check()
  await page.getByRole("button", { name: "Review the chosen" }).click()

  await expect(page.getByTestId("repo-files")).toContainText(
    `Take notes (${RUN}).`,
  )
  await expect(page.getByTestId("repo-flags")).toContainText(
    "nothing that reaches further",
  )
  await clickHydrated(page.getByRole("button", { name: "Add this item" }))
  await expect(page.getByText("Added 1 of 1.")).toBeVisible()

  await page.goto("/skills")
  await expect(
    page.getByRole("link", { name: new RegExp(SKILL) }),
  ).toBeVisible()
})

test("a change from the untrusted repository waits in the bell until the owner approves it", async ({
  page,
}) => {
  github.commit(OWNER, NAME, {
    ...github.files(OWNER, NAME),
    [`skills/${SKILL}/SKILL.md`]: skillMd(`Take better notes (${RUN}).`),
  })

  await page.goto("/settings/repositories")
  await page.getByRole("link", { name: new RegExp(NAME) }).click()
  await clickHydrated(page.getByRole("button", { name: "Sync now" }).first())
  await expect(page.getByText(/not one you trust/)).toBeVisible()

  await page.reload()
  // This run's change: an earlier run's may still wait in the bell.
  await openRequestFromBell(page, `Change to review in skills/${SKILL}`)
  await expect(page.getByTestId("repo-files")).toContainText(
    `Take better notes (${RUN}).`,
  )
  // Nothing changed yet.
  await page.goto("/skills")
  await expect(page.getByText(`Take notes (${RUN}).`)).toBeVisible()

  await page.goBack()
  await clickHydrated(page.getByRole("button", { name: "Approve" }))
  // The answer, or the page read again once it was applied (with the answer
  // above it when nothing else waits), or the next thing waiting with the
  // answer above it.
  await expect(
    page
      .getByText(/Applied as you were shown it|in step, or you answered/)
      .first(),
  ).toBeVisible()

  await page.goto("/skills")
  await expect(page.getByText(`Take better notes (${RUN}).`)).toBeVisible()
  // Every request carried no credential: the repository is public.
  expect(
    github.requests.every((request) => request.authorization === null),
  ).toBe(true)
})
