// patchright-core publishes lib/coreBundle (allowed by its exports map)
// without types. Only what lib/core/browser/install.ts uses: where
// Playwright downloads the Chromium this version drives from, and its unzip.
declare module "patchright-core/lib/coreBundle" {
  type Executable = {
    /** Where Playwright itself would install it. */
    directory?: string
    /** Playwright's own addresses for the build, for this platform. */
    downloadURLs: string[]
    revision?: string
    executablePath(): string | undefined
  }

  export const registry: {
    registry: {
      findExecutable(name: "chromium"): Executable | undefined
    }
  }

  export const utils: {
    /** Keeps symbolic links and modes, which the macOS app bundle needs. */
    extractZip(zipPath: string, options: { dir: string }): Promise<void>
  }
}
