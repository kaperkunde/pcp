/**
 * What this process knows of each vault's conversion (convert.ts): kept
 * on globalThis, since instrumentation and the routes are bundled apart.
 * Its own module so a restore or a deleted vault can forget a vault
 * without importing the converters.
 */

const STATE = Symbol.for("pcp.sealed-vaults")

export type SealingState = {
  /** Vaults this process found with nothing left to seal. */
  sealed: Set<string>
  /** Vaults this process sealed rows of, whose file is not rebuilt yet. */
  dirty: Set<string>
  /** The conversion under way, per vault: one at a time. */
  running: Map<string, Promise<boolean>>
}

export function sealingState(): SealingState {
  const holder = globalThis as unknown as { [STATE]?: SealingState }
  holder[STATE] ??= { sealed: new Set(), dirty: new Set(), running: new Map() }
  return holder[STATE]
}

/** Whether this process found the vault with nothing left to seal. */
export function knownSealed(vaultId: string): boolean {
  return sealingState().sealed.has(vaultId)
}

/**
 * The vault's rows were replaced (a restore) or are gone (deleted): what
 * this process knew of them no longer holds.
 */
export function forgetSealedVault(vaultId: string): void {
  const state = sealingState()
  state.sealed.delete(vaultId)
  state.dirty.delete(vaultId)
}

/** Tests: forget every vault. */
export function forgetSealedVaults(): void {
  const state = sealingState()
  state.sealed.clear()
  state.dirty.clear()
  state.running.clear()
}
