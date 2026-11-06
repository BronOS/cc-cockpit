// The model and effort a plugin may ask for in ctx.sessions.open. One rule for the plugin host
// (fast TypeError) and main (the authority, which checks again), imported by neither the panel SDK
// nor the renderer (src/sdk/panel.ts is a classic script: a module it shares with main becomes a
// chunk loaded with `require`, CLAUDE.md).
//
// Both are closed lists on purpose: the value becomes the argument of `--model` / `--effort`, and an
// open string would let a plugin pass something that starts with `-` (read as a flag) or name a
// model the person never chose. Full model names are left out: an alias follows the person's
// installed Claude, a pinned name goes stale. `fable` is allowed: the person picks the model in
// their own plugin rules (autopilot), so it is their choice, not the plugin's.

export const SESSION_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type SessionModel = (typeof SESSION_MODELS)[number]
export type SessionEffort = (typeof SESSION_EFFORTS)[number]

export type SessionOptionsCheck =
  | { ok: true; model?: SessionModel; effort?: SessionEffort }
  | { ok: false; reason: string }

/**
 * Both fields are optional (absent or undefined: the person's default). Anything else, a
 * non-string included, is refused with a reason that names the field.
 */
export function checkSessionOptions(raw: { model?: unknown; effort?: unknown }): SessionOptionsCheck {
  const { model, effort } = raw
  if (model !== undefined && (typeof model !== 'string' || !(SESSION_MODELS as readonly string[]).includes(model))) {
    return { ok: false, reason: `model must be one of ${SESSION_MODELS.join(', ')}` }
  }
  if (effort !== undefined && (typeof effort !== 'string' || !(SESSION_EFFORTS as readonly string[]).includes(effort))) {
    return { ok: false, reason: `effort must be one of ${SESSION_EFFORTS.join(', ')}` }
  }
  return {
    ok: true,
    ...(model !== undefined ? { model: model as SessionModel } : {}),
    ...(effort !== undefined ? { effort: effort as SessionEffort } : {})
  }
}
