import { expect, test } from "@playwright/test"

import { startGitHub, type FakeGitHub } from "../fixtures/github"
import { addSecret, clickHydrated, openRequestFromBell } from "../lib/ui"

// Linked repositories against the fake GitHub (e2e/fixtures/github.ts): the
// owner links a public repository from Settings, adds a skill from it after
// reading every file, and finds it on the repository's page as imported. A
// later change from it is an update available, on the skill's page and in
// the bell, and changes nothing until they read it and take it. Then they
// push a skill of their own to a public repository they can push to, after
// its review: every file, what stays private, and an email address that
// keeps Confirm waiting until they tick it as fine to publish.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const OWNER = "e2e"
const NAME = `shared-${RUN}`
const MINE = `mine-${RUN}`
const SKILL = `e2e-${RUN}-notes`
const OWN_SKILL = `e2e-${RUN}-postcards`
const PAT = `github_pat_E2E_${RUN}`

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
  github.addRepo(OWNER, MINE, { files: { "README.md": "Ours, public." } })
  github.tokens.set(PAT, { push: true })
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
  // GitHub said it is public.
  await expect(page.getByTestId("repo-summary")).toContainText("Public")
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

  // The repository's page lists it as imported, under Skills.
  await page.goto("/settings/repositories")
  await page.getByRole("link", { name: new RegExp(NAME) }).click()
  await page
    .getByRole("link", { name: /^Imported/ })
    .first()
    .click()
  const table = page.getByTestId("repo-table")
  await expect(table.getByRole("rowgroup", { name: "Skills" })).toContainText(
    SKILL,
  )
  await expect(table).toContainText("Imported")
})

test("a newer version from the repository is an update available until the owner takes it", async ({
  page,
}) => {
  github.commit(OWNER, NAME, {
    ...github.files(OWNER, NAME),
    [`skills/${SKILL}/SKILL.md`]: skillMd(`Take better notes (${RUN}).`),
  })

  await page.goto("/settings/repositories")
  await page.getByRole("link", { name: new RegExp(NAME) }).click()
  await clickHydrated(page.getByRole("button", { name: "Sync now" }).first())
  await expect(page.getByText(/update is available/).first()).toBeVisible()

  // The skill's page says where it came from and that an update waits.
  await page.goto("/skills")
  await page.getByRole("link", { name: new RegExp(SKILL) }).click()
  await expect(
    page.getByText(new RegExp(`Imported from ${OWNER}/${NAME}@`)),
  ).toBeVisible()
  await expect(page.getByTestId("sync-status")).toHaveText("Update available")
  await expect(page.getByRole("link", { name: "Pull update" })).toBeVisible()

  // This run's change: an earlier run's may still wait in the bell.
  await openRequestFromBell(page, `Change to review in skills/${SKILL}`)
  await expect(
    page.getByRole("heading", { name: `Update available for skills/${SKILL}` }),
  ).toBeVisible()
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

test("pushes a skill of the owner's to a public repository, after its review", async ({
  page,
}) => {
  await addSecret(page, { name: `GitHub ${RUN}`, value: PAT })

  await page.goto("/skills")
  await page.getByRole("button", { name: "Add a skill" }).click()
  const skill = page.getByRole("dialog", { name: "Add a skill" })
  await skill.getByLabel("Name").fill(OWN_SKILL)
  await skill
    .getByLabel("When to use it")
    .fill(`Send a postcard; ask ada@lovelace-${RUN}.dev first.`)
  await skill.getByLabel("Steps").fill("1. Write three lines, no more.")
  await skill.getByRole("button", { name: "Save skill" }).click()
  await expect(page.getByRole("heading", { name: OWN_SKILL })).toBeVisible()

  await page.goto("/settings/repositories")
  await page.getByRole("button", { name: "Add a repository" }).click()
  const dialog = page.getByRole("dialog", { name: "Add a repository" })
  await dialog
    .getByLabel("Repository", { exact: true })
    .fill(`${OWNER}/${MINE}`)
  await dialog
    .getByRole("radio", { name: "Read and write", exact: true })
    .check()
  await dialog.getByRole("radio", { name: "A token", exact: true }).check()
  await dialog.getByLabel("Secret").selectOption({ label: `GitHub ${RUN}` })
  await dialog.getByRole("button", { name: "Add repository" }).click()
  await expect(
    page.getByRole("heading", { name: `${OWNER}/${MINE}` }),
  ).toBeVisible()

  // Not pushed: choose it, and Add selected opens its review.
  await page
    .getByRole("link", { name: /^Not pushed/ })
    .first()
    .click()
  await page.getByRole("checkbox", { name: `Choose ${OWN_SKILL}` }).check()
  await page.getByRole("button", { name: "Add selected" }).click()

  await expect(page.getByTestId("share-public")).toContainText(
    "This will be public",
  )
  await expect(page.getByTestId("share-files")).toContainText(
    `skills/${OWN_SKILL}/SKILL.md`,
  )
  await expect(page.getByTestId("share-private-panel")).toContainText(
    "Your note",
  )
  const hit = page
    .getByTestId("share-hit")
    .filter({ hasText: `ada@lovelace-${RUN}.dev` })
  await expect(hit).toContainText(`ada@lovelace-${RUN}.dev`)
  const confirm = page.getByRole("button", { name: /^Push to public/ })
  await expect(confirm).toBeDisabled()

  await hit.getByRole("checkbox", { name: /fine to publish/ }).check()
  await expect(confirm).toBeEnabled()
  await clickHydrated(confirm)

  await expect(page.getByText(`Pushed skills/${OWN_SKILL}.`)).toBeVisible()
  expect(github.files(OWNER, MINE)[`skills/${OWN_SKILL}/SKILL.md`]).toContain(
    "Send a postcard",
  )
  await page
    .getByRole("link", { name: /^Pushed/ })
    .first()
    .click()
  await expect(page.getByTestId("repo-table")).toContainText(OWN_SKILL)
})
