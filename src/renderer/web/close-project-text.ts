// The unsaved-changes line of server mode's Close project ask (CloseProject.tsx). DOM-free for its test.

/** At most this many titles are named; the rest are counted. */
const NAMED = 3

/** "Unsaved changes in a.ts, b.go and 2 more are lost." Titles are main's, checked and clamped (page-tabs.ts). */
export function unsavedText(titles: readonly string[]): string {
  const named = titles.slice(0, NAMED)
  const more = titles.length - named.length
  const list =
    more > 0 ? `${named.join(', ')} and ${more} more` : named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)!}` : named[0]!
  return `Unsaved changes in ${list} are lost.`
}
