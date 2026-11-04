# Development

Node 24 and pnpm 10. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the workflow
and [CLAUDE.md](../CLAUDE.md) for the conventions an agent (or a person) should
keep to.

```bash
pnpm install
pnpm db:generate
pnpm dev             # http://localhost:3000, data in ./data
pnpm test            # unit tests (vitest)
pnpm test:e2e        # Playwright, against a fresh e2e database
```

| Script             | Description                                       |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | Dev server (Turbopack); migrations apply at boot  |
| `pnpm build`       | Production build                                  |
| `pnpm start`       | Serve the production build                        |
| `pnpm lint`        | ESLint (`pnpm lint:fix` to auto-fix)              |
| `pnpm format`      | Prettier, writing (`pnpm format:check` to verify) |
| `pnpm typecheck`   | `tsc --noEmit`                                    |
| `pnpm test`        | Unit tests                                        |
| `pnpm test:e2e`    | Reset the e2e database, run the Playwright suite  |
| `pnpm db:generate` | Generate the Prisma client                        |
| `pnpm db:migrate`  | Create a migration after changing the schema      |

## Stack

Next.js 15 (App Router, Server Actions), React 19, TypeScript, Tailwind CSS 4
with shadcn/ui primitives, Prisma 7 on SQLite (`better-sqlite3`), the
`@modelcontextprotocol` v2 SDK for both the gateway and the upstream client,
QuickJS in WebAssembly for `run_code`, `patchright-core` driving Chromium for
the browser, Electron for the desktop apps, Vitest, Playwright, pnpm.
