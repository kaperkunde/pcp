/** Bounds on what a calendar account is asked for and what PCP passes on. */

export const DAV_CALL_TIMEOUT_MS = 60_000

/** The most PCP reads of one answer: a listing or a calendar's objects. */
export const MAX_DAV_RESPONSE_BYTES = 8 * 1024 * 1024
/** The most of one calendar object (an event with its exceptions). */
export const MAX_OBJECT_BYTES = 1024 * 1024
/** Redirects followed while finding the calendars, on the same origin. */
export const MAX_DISCOVERY_REDIRECTS = 3
export const MAX_CALENDARS = 200

/** The widest span list_events and find_free_time look across. */
export const MAX_RANGE_DAYS = 400
/** What list_events looks across when it is given no end. */
export const DEFAULT_RANGE_DAYS = 7
export const DEFAULT_EVENT_LIMIT = 50
export const MAX_EVENT_LIMIT = 500
export const DEFAULT_REMINDER_LIMIT = 50
export const MAX_REMINDER_LIMIT = 500
/** Occurrences one recurring event is stepped through before PCP stops. */
export const MAX_RECURRENCE_STEPS = 50_000
/** Notes a listing carries of each event or reminder; get_event has all. */
export const MAX_LISTED_NOTES_CHARS = 500
export const MAX_FREE_SLOTS = 100

export const MAX_TITLE_CHARS = 500
export const MAX_LOCATION_CHARS = 1_000
export const MAX_NOTES_CHARS = 20_000
export const MAX_URL_CHARS = 2_000
export const MAX_SEARCH_TEXT_CHARS = 200
export const MAX_ALERTS = 10
/** Alerts as minutes before the start: four weeks at most. */
export const MAX_ALERT_MINUTES = 40_320
/** Reminders one complete_reminder changes. */
export const MAX_BULK_REMINDERS = 100
export const MAX_CALENDAR_NAME_CHARS = 200
