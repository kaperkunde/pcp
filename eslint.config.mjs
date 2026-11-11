import { nextConfig } from "@kaperkunde/config/eslint"

// The shared preset (@kaperkunde/config): Next's core web vitals and
// TypeScript rules, Prettier's formatting rules off, no semicolons. What
// follows is PCP's own.
export default nextConfig({
  ignores: [
    "data/**",
    // Claude Code's worktrees: other checkouts, each with its own deps.
    ".claude/**",
    // The desktop app's staged server, native-module cache and installers.
    "desktop/server/**",
    "desktop/.cache/**",
    "desktop/dist/**",
    "desktop/native/keychain/build/**",
    "desktop/native-staged/**",
  ],
  extra: [
    {
      rules: {
        // eslint-plugin-react-hooks 7 (with eslint-config-next 16) adds the
        // React Compiler's diagnostics as errors. PCP does not build with the
        // compiler, and the code they flag (a state set once after mount, a
        // hook's object that carries a ref, a server component's Date.now())
        // is what it means to do. Off until the compiler is taken up.
        "react-hooks/purity": "off",
        "react-hooks/refs": "off",
        "react-hooks/set-state-in-effect": "off",
      },
    },
    {
      // lib/core is the embeddable domain layer (see ARCHITECTURE.md): it
      // must stay free of Next.js and React so another host — a multi-tenant
      // one, a CLI, a test — can drive it with an explicit VaultContext.
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
      // The image's entry point runs Next.js's standalone server.js, which
      // is CommonJS, after the listen address is picked.
      files: [
        "docker/start.cjs",
        "docker/peer-stamp.cjs",
        "desktop/server-entry.cjs",
      ],
      rules: {
        "@typescript-eslint/no-require-imports": "off",
      },
    },
  ],
})
