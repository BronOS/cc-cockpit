// The Ask API's caps (shared/design.md §5, spec-review S5, design-parts.md §7 for D14): one leaf with no imports,
// read by main (the authority) and the page SDK (a fast refusal before the round trip). A leaf like
// overlay-message.ts, so panel.js's own IIFE build can take it in without a shared chunk.

/** Live chats per copy: a new start on the same copy replaces its chat (S5 A3). */
export const ASK_MAX_PER_COPY = 1
/** Live chats per plugin per window; a start past it is refused. */
export const ASK_MAX_PER_PLUGIN_WINDOW = 3
/** Live chats in the whole app; a start past it is refused. */
export const ASK_MAX_PER_APP = 6
/** New chats a minute per window; a start past it is refused. */
export const ASK_STARTS_PER_MINUTE = 10
/** The document the opener's `onAsk` gives, in characters: cut there by the host, with a note main adds. */
export const ASK_MAX_DOCUMENT = 100_000
/** One question; a longer one is refused, never cut. */
export const ASK_MAX_QUESTION = 10_000
/** The quoted selection a question is about (S5 A9); a longer one is refused. */
export const ASK_MAX_QUOTE = 10_000
/** One answer, in characters; cut there. */
export const ASK_MAX_ANSWER = 100_000
/** One turn, from the question to its answer: past it the turn is ended. */
export const ASK_TURN_MS = 5 * 60_000
/** A chat with no question for this long is ended (its process; the stored chat stays, D14). */
export const ASK_IDLE_MS = 15 * 60_000
/** How long the opener's `onAsk` (and each part's) may take to answer; a timeout refuses (S5). */
export const ASK_CONTEXT_MS = 10_000
/** Stored chats per (project, plugin), oldest evicted (design-parts.md §7). */
export const ASK_STORE_MAX_KEYS = 1000
/** One stored chat's turns, in characters of JSON; the oldest turns go first. */
export const ASK_STORE_MAX_TURNS_CHARS = 200_000
