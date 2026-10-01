import { db } from "./db"

/**
 * Settings of the machine PCP runs on rather than of a vault: dynamic DNS
 * and HTTPS (lib/core/network/). Background work reads them while nobody is
 * signed in, so they are stored as plain text and take no VaultContext. The
 * Server Actions that change them require a session; nothing from a vault
 * (a secret, a token) is ever copied in here.
 */

export async function getHostSetting(key: string): Promise<string | null> {
  const row = await db().hostSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function setHostSetting(
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await db().hostSetting.deleteMany({ where: { key } })
    return
  }

  await db().hostSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

/** A JSON host setting, or null when it is missing or unreadable. */
export async function getHostJson<T>(key: string): Promise<T | null> {
  const value = await getHostSetting(key)

  if (value === null) {
    return null
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export async function setHostJson(key: string, value: unknown): Promise<void> {
  await setHostSetting(key, value === null ? null : JSON.stringify(value))
}
