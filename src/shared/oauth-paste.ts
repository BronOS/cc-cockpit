// A plugin's OAuth sign-in in server mode (design-web.md §9.9): the provider redirects the person's
// browser to main's loopback on the server's 127.0.0.1, which that browser cannot reach, so the tab
// ends on an address that does not load. The person pastes that address into the sign-in notice
// (ShellNotices), and main settles the pending sign-in with it in-process (`oauth.paste`, main's
// plugin-oauth.ts), making no request. Shared by main and the shell page.

/**
 * The longest pasted text main reads: the loopback's address with a code (at most 4096 characters,
 * oauth.ts) and a state, with room for a provider's extra parameters. Longer is refused unread.
 */
export const MAX_OAUTH_PASTE_LENGTH = 8192

/**
 * The one answer to every refused paste, whatever the reason (no such sign-in, another window's, a
 * wrong address, the attempt limit, the desktop): a reason would tell a guesser which part was right,
 * and the text never echoes the pasted address (it carries the code).
 */
export const OAUTH_PASTE_REFUSED = 'That address does not finish a sign-in waiting in this window.'

/**
 * What a sign-in notice says once main ended its sign-in without a code (`oauth.signInEnded`): timed
 * out, the attempt limit, replaced by a new one, cancelled, or the provider's refusal. The plugin has
 * its own error; the person is told to start again there.
 */
export const OAUTH_SIGN_IN_OVER = 'This sign-in is over without finishing. Start it again from the plugin if you still need it.'

/** `oauth.paste`'s answer: settled (the plugin goes on with the code or the provider's refusal), or refused. */
export type OAuthPasteAnswer = { ok: true } | { ok: false; error: string }

/** A sign-in id main mints (randomToken(16), base64url): what a notice may carry and a paste may name. */
export function isSignInId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 64) return false
  for (const ch of value) {
    const ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_'
    if (!ok) return false
  }
  return true
}
