import { dirname } from "path"
import { fileURLToPath } from "url"
import { FlatCompat } from "@eslint/eslintrc"
import prettier from "eslint-config-prettier"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  prettier,
  {
    rules: {
      semi: ["error", "never"],
    },
  },
  {
    // lib/core is the embeddable domain layer (see ARCHITECTURE.md): it must
    // stay free of Next.js and React so another host — a multi-tenant one,
    // a CLI, a test — can drive it with an explicit VaultContext.
    files: ["lib/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "next",
                "next/*",
                "react",
                "react-dom",
                "@/lib/actions/*",
                "@/lib/server/*",
                "@/components/*",
                "@/app/*",
              ],
              message:
                "lib/core must not depend on the Next.js host. Pass what you need in through VaultContext or function arguments.",
            },
          ],
        },
      ],
    },
  },
  {
    // A sandboxed preload is CommonJS: require is the only way it gets
    // Electron's renderer modules.
    files: ["desktop/preload.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "lib/generated/**",
      "next-env.d.ts",
      "data/**",
      // Playwright output (reports, traces) and captured auth/state.
      "e2e/.artifacts/**",
      "e2e/.auth/**",
      "e2e/.state/**",
      // The desktop app's staged server, native-module cache and installers.
      "desktop/server/**",
      "desktop/.cache/**",
      "desktop/dist/**",
    ],
  },
]

export default eslintConfig
