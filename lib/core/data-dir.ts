import path from "node:path"

/**
 * Everything PCP writes lives under one directory: the SQLite database, the
 * request log and any file the app keeps outside the database. It defaults
 * to ./data (the Docker image sets PCP_DATA_DIR=/data and mounts a volume
 * there), so a fresh checkout or container needs no configuration.
 */
export function dataDir(): string {
  const configured = process.env.PCP_DATA_DIR?.trim()
  return path.resolve(configured && configured.length > 0 ? configured : "data")
}

export function databaseFile(): string {
  return path.join(dataDir(), "pcp.db")
}

export function databaseUrl(): string {
  return `file:${databaseFile()}`
}

export function logDir(): string {
  return path.join(dataDir(), "logs")
}
