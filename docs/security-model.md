# How PCP is secured

The short version: everything sensitive is AES-256-GCM ciphertext under a
per-vault data key, and that key is stored only wrapped under keys derived from
credentials the server does not keep — your password (scrypt), a session cookie,
an API token, what an app that signed in holds (its access and refresh tokens),
the recovery key or the Mac app's Touch ID key (HKDF). A request
that presents one of those unwraps the key for its own duration and drops it.
Someone with the disk has ciphertext and hashes.
[ARCHITECTURE.md](../ARCHITECTURE.md) has the full model;
[SECURITY.md](../SECURITY.md) has the threat model and how to report a problem.

Consequences worth knowing:

- Changing the password re-wraps the key; sessions and API tokens keep
  working. Using the recovery key signs every browser out, turns Touch ID off,
  forgets the pinned public address and can revoke every API token.
- A stolen session cannot make an API token or a recovery key: both ask for
  the password again (a token, in the Mac app, takes Touch ID instead). Letting
  an app sign in makes a token, so it asks too, and so does changing PCP's
  public address, which decides where sign-ins and permission links go.
- Losing the password **and** the recovery key loses the data. That is the
  design, not a bug.
- An export is the encrypted vault as it is, under an export password of
  your own on top: reading one takes that password and your PCP password (or
  the recovery key, or a token). Nothing is decrypted to make it.
- The gateway never returns a secret to an assistant, only what the upstream
  server answered. An API's answer is scrubbed of the secret or token first,
  in case it echoes the key back in an error.
