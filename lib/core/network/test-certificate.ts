import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * A self-signed certificate for tests, made with the openssl command line
 * (there on every CI runner and developer machine PCP is built on).
 */
export function selfSignedCertificate(
  domain: string,
  days = 90,
): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pcp-cert-"))

  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-days",
        String(days),
        "-subj",
        `/CN=${domain}`,
        "-addext",
        `subjectAltName=DNS:${domain}`,
      ],
      { stdio: "ignore" },
    )

    return {
      key: readFileSync(path.join(dir, "key.pem"), "utf8"),
      cert: readFileSync(path.join(dir, "cert.pem"), "utf8"),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
