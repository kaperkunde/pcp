/**
 * What every operation on a vault needs: which vault, and the key that
 * decrypts it. The key arrives with the request (a session cookie, an API
 * token, the password on login) and lives only as long as the request.
 *
 * lib/core takes this explicitly everywhere instead of reading a global
 * "current user", which is what lets one process serve many vaults.
 */
export type VaultContext = {
  vaultId: string
  dek: Buffer
}
