// Where a hook (and `ccc statusline`) reports: its own small file, so the status line path can
// load it without client.ts and the bundled guide text behind it (cli/statusline.ts).
type Env = Record<string, string | undefined>

/**
 * The socket a hook reports to: `$CC_COCKPIT_SOCK`, and only inside a tab (`$APP_TAB_TOKEN` set).
 * Main exports CC_COCKPIT_SOCK to a tab only while its server listens on that path, because a
 * path main could not bind (a foreign listener, another user's pre-created `ccc-<uid>/` on a
 * shared /tmp) may belong to someone else, and the hook would hand them the token and every
 * prompt. So there is deliberately no fallback to `socketPath()` here: a tab without the variable
 * belongs to an app that is not listening, and a call without a token has no tab to report for.
 */
export function hookSocketPath(env: Env): string | undefined {
  if (!env.APP_TAB_TOKEN) return undefined
  return env.CC_COCKPIT_SOCK || undefined
}
