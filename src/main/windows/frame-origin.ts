// The rule create-window.ts applies to a subframe navigating itself (a plugin panel, an
// overlay): it may only move within its own origin. Kept apart from create-window.ts, which
// imports Electron, so vitest can pin the edge cases (test/unit/frame-origin.test.ts).

/**
 * Same scheme and host (an app scheme's host is the plugin or overlay id). False when either URL
 * is missing or unparsable, and for an empty host: an opaque origin (about:blank, data:, a
 * `cc-plugin:` URL without a plugin id) is never "the same" as anything, or a frame could step
 * from one onto another plugin's page.
 */
export function sameOrigin(from: string | undefined, to: string): boolean {
  if (from === undefined) return false
  try {
    const a = new URL(from)
    const b = new URL(to)
    return a.protocol === b.protocol && a.host === b.host && a.host !== ''
  } catch {
    return false
  }
}
