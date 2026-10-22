import { E2E_GITHUB_PORT } from "../lib/network"
import {
  startFakeGitHub,
  type FakeGitHub,
} from "../../lib/core/repos/fake-github"

/**
 * GitHub for the e2e suite: lib/core/repos/fake-github.ts (the REST API's
 * repositories, refs, commits, trees and blobs, and the device flow) on the
 * fixed port the dev server is pointed at (PCP_GITHUB_API_URL in
 * playwright.config.ts). A spec starts it, fills its repositories, and
 * closes it; nothing answers there otherwise, so no spec reaches GitHub.
 */
export function startGitHub(): Promise<FakeGitHub> {
  return startFakeGitHub({ port: E2E_GITHUB_PORT })
}

export type { FakeGitHub }
