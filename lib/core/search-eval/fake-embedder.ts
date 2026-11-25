import { stem, tokenize } from "../search"

/**
 * A deterministic stand-in for an embeddings model, for the eval's blended
 * run: a text becomes a vector over a small set of concepts (words an
 * owner would treat as meaning the same), plus a faint hashed bag of its
 * own words. It is an idealised model, one that knows what the fixture's
 * phrases mean, so what it measures is how search.ts blends a good
 * similarity in, not how good any real model is (the live variant does
 * that). No network, no randomness.
 */

const CONCEPTS: string[][] = [
  [
    "spend",
    "spent",
    "cost",
    "bill",
    "billing",
    "charge",
    "usd",
    "price",
    "money",
    "expense",
  ],
  ["message", "whatsapp", "chat", "text", "messenger", "contact", "partner"],
  ["post", "publish", "facebook", "social", "page"],
  ["print", "printer", "copy", "paper"],
  ["image", "picture", "photo", "pic", "media"],
  ["upload", "website", "site"],
  ["transcribe", "audio", "voice", "memo", "recording", "speech", "speaker"],
  ["coding", "code", "session", "repo", "repository"],
  ["bank", "balance", "account", "payment", "iban", "money"],
  ["appointment", "book", "booking", "customer", "reservation"],
  ["scan", "scanner", "document", "feeder"],
  ["movie", "film", "download", "torrent", "library", "release"],
  ["calendar", "event", "tomorrow", "schedule", "agenda"],
  ["mail", "email", "emailed", "mailbox", "inbox", "sender", "invoice"],
  ["server", "status", "monitor", "uptime", "instance", "health", "down"],
  ["claude", "usage", "token", "organisation", "organization", "report"],
]

const BUCKETS = 48

function bucket(word: string): number {
  let hash = 2166136261

  for (const char of word) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  }

  return (hash >>> 0) % BUCKETS
}

const CONCEPT_OF = new Map<string, number[]>()

CONCEPTS.forEach((words, index) => {
  for (const word of words) {
    const key = stem(word)
    CONCEPT_OF.set(key, [...(CONCEPT_OF.get(key) ?? []), index])
  }
})

export function fakeEmbed(text: string): Float32Array {
  const vector = new Float32Array(CONCEPTS.length + BUCKETS)

  for (const word of tokenize(text).map(stem)) {
    for (const concept of CONCEPT_OF.get(word) ?? []) {
      vector[concept]! += 1
    }

    vector[CONCEPTS.length + bucket(word)]! += 0.15
  }

  return vector
}
