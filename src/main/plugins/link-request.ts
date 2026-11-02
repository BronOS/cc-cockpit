// `ccc plugin link` (plan B Task 6): the rules around the confirm dialog, kept apart from Electron
// so unit tests can drive them.
//
// Why a dialog at all: a linked plugin persists across sessions and runs with full Node access (no
// sandbox, design §5). A Claude session that can run `ccc` must therefore never be able to link
// one on its own: a person confirms, in the app's own window, with the name and the real folder
// path in front of them. The pieces:
//  - the plugin's manifest `name` is plugin-controlled text shown in a trusted dialog, so control
//    and direction-override characters are stripped and the length is cut (no fake second line, no
//    right-to-left trick that reorders "Allow");
//  - at most one pending dialog per window (a second request is refused, not queued: a session
//    cannot stack dialogs until the person clicks one by reflex), and at most MAX_LINK_REQUESTS a
//    minute per window (a loop cannot nag the person into it either);
//  - at most MAX_LINK_INSPECTIONS requests a minute per window are looked at at all: each one
//    reads the folder's manifest and walks its skills (up to 1000 entries and 1 MiB, partly on
//    main's thread) before any dialog, so a loop of `ccc plugin link <dir>` that never gets as far
//    as a dialog (an invalid folder, a dialog already open) must not keep main busy either.

/** Most link requests (that got as far as a dialog) one window may make in LINK_WINDOW_MS. */
export const MAX_LINK_REQUESTS = 3
export const LINK_WINDOW_MS = 60_000
/** Most link requests one window may have inspected (dialog or not) in LINK_WINDOW_MS. */
export const MAX_LINK_INSPECTIONS = 10
/** Longest name or path shown in the dialog; the rest is cut with an ellipsis. */
export const MAX_DIALOG_FIELD = 200


/**
 * Controls (C0, C1, DEL), format characters (zero-width, bidi marks, embeddings, overrides and
 * isolates, BOM) and the line and paragraph separators.
 */
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Text from a plugin or a path, made safe to show in one dialog line. */
export function displayText(text: string, max: number = MAX_DIALOG_FIELD): string {
  const clean = text.replace(UNSAFE_DISPLAY, '').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * A path made short for the dialog by cutting its start: the last folders (the plugin's own name)
 * are what a person needs to judge, and a cut at the end would hide them.
 */
export function displayPath(path: string, max: number = MAX_DIALOG_FIELD): string {
  const clean = path.replace(UNSAFE_DISPLAY, '').trim()
  return clean.length > max ? `…${clean.slice(clean.length - (max - 1))}` : clean
}

/**
 * Who asked, as far as main knows: `tab` is a `ccc` run in one of the window's tabs (its token;
 * a Claude tab's session token, or the window token of a shell or command tab or of a terminal
 * overlay over the window, alike), `project` one run outside any tab that named the
 * project with `--project` (any program of this user could have).
 */
export type LinkCaller = 'tab' | 'project'

/** What the dialog says; the strings are already display-safe. */
export interface LinkDialogInfo {
  id: string
  name: string
  path: string
  caller: LinkCaller
}

export function linkDialogInfo(info: { id: string; name: string; dir: string }, caller: LinkCaller): LinkDialogInfo {
  return { id: displayText(info.id), name: displayText(info.name), path: displayPath(info.dir), caller }
}

export class LinkRequestGate {
  private readonly pending = new Set<number>()
  private readonly recent = new Map<number, number[]>()
  private readonly inspected = new Map<number, number[]>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max: number = MAX_LINK_REQUESTS,
    private readonly windowMs: number = LINK_WINDOW_MS,
    private readonly maxInspections: number = MAX_LINK_INSPECTIONS
  ) {}

  /**
   * Claim the right to inspect a folder for `windowId` (before any dialog): every request counts,
   * whatever comes of it. Throws the reason for a refusal (it reaches `ccc` as the error text).
   */
  inspect(windowId: number): void {
    const now = this.now()
    const times = (this.inspected.get(windowId) ?? []).filter((t) => now - t < this.windowMs)
    if (times.length >= this.maxInspections) {
      throw new Error(`too many plugin link requests (at most ${this.maxInspections} a minute, dialog or not); wait and try again`)
    }
    times.push(now)
    this.inspected.set(windowId, times)
  }

  /**
   * Claim the right to show a dialog in `windowId`. Returns the release function to call when the
   * dialog is closed; throws the reason for a refusal (it reaches `ccc` as the error text).
   * A refusal does not count against the rate: only dialogs that were allowed to open do.
   */
  begin(windowId: number): () => void {
    if (this.pending.has(windowId)) {
      throw new Error('a link confirmation is already open in this window; answer it first')
    }
    const now = this.now()
    const times = (this.recent.get(windowId) ?? []).filter((t) => now - t < this.windowMs)
    if (times.length >= this.max) {
      throw new Error(`too many link requests (at most ${this.max} a minute); wait and try again`)
    }
    times.push(now)
    this.recent.set(windowId, times)
    this.pending.add(windowId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.pending.delete(windowId)
    }
  }
}
