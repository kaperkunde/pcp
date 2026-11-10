/**
 * Bounds for capabilities (capabilities/): how many of a token's tools are
 * read for their arguments, how many providers one call runs, and when two
 * readings or one reading's confidence are worth a flag.
 */

/** At most this many of the token's tools are read for their schemas. */
export const MAX_SCHEMAS_READ = 300

/** read_image runs at most this many providers on one file. */
export const MAX_READ_PROVIDERS = 4

/** edit_pdf and convert_document try at most this many, best first. */
export const MAX_TRIED_PROVIDERS = 3

/**
 * The resolution convert_document asks a PDF's page in (to "png"), in dots
 * per inch: an A4 page comes out about 1240 by 1754 pixels, small print
 * still legible.
 */
export const PAGE_DPI = 150

/** edit_pdf's merge takes at most this many files. */
export const MAX_MERGED_FILES = 20

/**
 * Two readings whose words overlap less than this (Dice's coefficient over
 * their words, 0 to 1) disagree.
 */
export const AGREEMENT_MIN = 0.9

/** A reading below this confidence (0 to 1) is flagged as low. */
export const LOW_CONFIDENCE = 0.8

/** The most characters of each reading compared word by word. */
export const MAX_COMPARED_CHARS = 200_000

/** The most characters of a provider's answer a capability is handed. */
export const MAX_ANSWER_CHARS = 400_000

/** The most numbers a disagreement names. */
export const MAX_NAMED_NUMBERS = 8
