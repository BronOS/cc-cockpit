// Claude's changes in the gutter, the page's side of it with no DOM and no CodeMirror (changes-editor.js
// draws it; node:test drives this, test/page-changes.test.mjs). design-editor.md §4 "Claude's changes in
// the gutter": lines that differ from git `HEAD` get a bar, hover shows the old lines, a click opens the
// Reviewer's diff. The host (dist/lib/git.js) hands over the file's text at HEAD (`git-base`); the line
// diff is made here, where the buffer is, and again after every pause in typing.
//
// Protocol (host side in lib/git.js):
//   page -> host  { t: 'git-base', req }                         ask the file's text at HEAD
//                 { t: 'git-review' }                            a click on a mark: the Reviewer's diff
//   host -> page  { t: 'git-base', req, has, part?, parts?, text? }   has false: no marks (not a repository, untracked, ...)
//                 { t: 'git-review-error', message }
//
// The base is asked again on every new line (a host restart, a reconnect), on loading, on a disk change
// (a checkout, a revert) and when the tab gets focus again (Claude may have committed meanwhile), at most
// once per FOCUS_MIN_MS for the last, and every POLL_MS while the page is visible (a commit made while the
// editor keeps the keyboard, a checkout that leaves this file's bytes alone).

import { diffLines, splitLines } from './merge.mjs'

/** Focus asks again at most this often (a commit made while the tab was away is seen on return). */
export const FOCUS_MIN_MS = 2000
/** A hunk keeps at most this many old lines (and this many characters of each) for the hover. */
/** While the page is visible the base is asked again this often. */
export const POLL_MS = 15 * 1000
export const MAX_OLD_LINES = 30
export const MAX_OLD_CHARS = 200

const clip = (s) => (s.length > MAX_OLD_CHARS ? `${s.slice(0, MAX_OLD_CHARS)}…` : s)

/**
 * The changed hunks of `text` against `base`, in order of the new text:
 * `{ kind: 'added' | 'modified' | 'deleted', line, count, old, oldCount }`. `line` is the 1-based first
 * new line (an added or modified hunk covers `count` lines from it); a `deleted` hunk has `count` 0 and
 * `line` is the line the removed ones sat before (`line` past the last line means the end of the text).
 * No hunks when the diff gave up (too many edits to tell). `old` is the old lines (no newline, cut at MAX_OLD_LINES and MAX_OLD_CHARS), `oldCount` all of them.
 */
export function hunksOf(base, text) {
  if (base === text) return []
  const a = splitLines(base)
  const b = splitLines(text)
  const diff = diffLines(a, b)
  // The diff gave up (past merge.mjs MAX_EDITS: a reformatted file): one hunk over everything would put a
  // "modified" bar on every line with unrelated old lines in the hover, so no marks.
  if (diff.gaveUp) return []
  return diff.map((r) => {
    const removed = a.slice(r.aS, r.aE)
    const old = removed.slice(0, MAX_OLD_LINES).map((l) => clip(l.endsWith('\n') ? l.slice(0, -1) : l))
    const count = r.bE - r.bS
    return {
      kind: count === 0 ? 'deleted' : removed.length === 0 ? 'added' : 'modified',
      line: r.bS + 1,
      count,
      old,
      oldCount: removed.length,
    }
  })
}

/**
 * The page's base and its asks. `ui`:
 *   post(message)        to the host (ccPanel.post)
 *   onBase()             the base changed (arrived, or gone): redraw the marks
 *   onError(message)     the diff could not be opened
 * `timers` { now() } (tests pass a fake clock).
 */
export function createChanges(ui, timers = { now: () => Date.now() }) {
  /** The file's text at HEAD, or null: no marks. */
  let base = null
  let nextReq = 0
  /** { req, texts, got } of the answer being assembled. */
  let waiting = null
  let lastAsk = -Infinity

  function ask() {
    lastAsk = timers.now()
    waiting = { req: ++nextReq, texts: [], got: 0 }
    ui.post({ t: 'git-base', req: waiting.req })
  }

  return {
    /** The base now (null: none). */
    base: () => base,
    /** Ask for the base. */
    refresh: ask,
    /** A new line to the host: its answer to an older ask never comes. */
    connect: ask,
    /** The tab got the keyboard or the window back: Claude may have committed. */
    focus() {
      if (timers.now() - lastAsk >= FOCUS_MIN_MS) ask()
    },
    /** A timer tick while the page is visible: asks again when the last ask is older than POLL_MS. */
    poll() {
      if (timers.now() - lastAsk >= POLL_MS) ask()
    },
    /** The mark was clicked. */
    review: () => ui.post({ t: 'git-review' }),
    /** True when `m` is ours. */
    receive(m) {
      if (!m || typeof m !== 'object') return false
      if (m.t === 'git-review-error') {
        ui.onError(typeof m.message === 'string' ? m.message : 'Could not open the diff.')
        return true
      }
      if (m.t !== 'git-base') return false
      // An answer to an older ask (the page asked again since): ignored.
      if (!waiting || m.req !== waiting.req) return true
      if (m.has !== true) {
        waiting = null
        if (base !== null) {
          base = null
          ui.onBase()
        }
        return true
      }
      const parts = Number.isInteger(m.parts) && m.parts >= 1 ? m.parts : 1
      const i = Number.isInteger(m.part) && m.part >= 0 && m.part < parts ? m.part : 0
      if (typeof m.text !== 'string') return true
      if (!(i in waiting.texts)) waiting.got++
      waiting.texts[i] = m.text
      if (waiting.got < parts) return true
      const text = waiting.texts.join('')
      waiting = null
      if (text !== base) {
        base = text
        ui.onBase()
      }
      return true
    },
  }
}
