// Line diffs and the three-way merge of the file tab page (design-editor.md §2 "Claude changes the
// file"), with no DOM and no CodeMirror: session.mjs merges, file.js turns a diff into editor changes,
// node:test drives both (test/merge.test.mjs).
//
// The page keeps its own base, so when the disk changes under a dirty buffer it holds all three
// texts: its base, its buffer (mine) and the disk (theirs). merge3 is a line-based diff3: each side's
// changes against the base are found with Myers' diff, changes of both sides that overlap OR touch
// make one region, and a region both sides changed is a conflict unless they made the same change.
// Touching counts as overlapping on purpose (git does the same): two edits on adjacent lines are
// rarely independent, and a conflict asks the person where a silent merge could break the code.
//
// Lines keep their '\n' (the last one may have none), so joining lines gives back the exact text and
// "a final newline added" is a change like any other. The page's text is LF already (the host turns
// a CRLF file into LF and back on save), so '\n' is the only separator.

/**
 * A diff with more edits than this gives up and calls the whole differing middle one change: the
 * trace Myers keeps grows with the square of the edit count, and a page must never stall on a
 * reformatted 5 MB file. The merge then only gets coarser (one big region, more likely a conflict),
 * never wrong.
 */
export const MAX_EDITS = 2000

/** `text` as lines, each with its '\n' (the last one without when the text has no final newline). */
export function splitLines(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const j = text.indexOf('\n', i)
    if (j === -1) {
      out.push(text.slice(i))
      break
    }
    out.push(text.slice(i, j + 1))
    i = j + 1
  }
  return out
}

/**
 * The changed regions between line lists `a` and `b`, in order: `{ aS, aE, bS, bE }` says lines
 * a[aS, aE) became b[bS, bE) (either range may be empty: an insertion, a deletion). Lines between
 * regions are equal.
 */
export function diffLines(a, b) {
  // Lines as small ints: the inner loop compares numbers, not strings.
  const ids = new Map()
  const intern = (lines) => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i])
      if (id === undefined) ids.set(lines[i], (id = ids.size))
      out[i] = id
    }
    return out
  }
  const x = intern(a)
  const y = intern(b)
  // The common head and tail never take part: most reloads change a few lines of a long file.
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let post = 0
  while (post < x.length - pre && post < y.length - pre && x[x.length - 1 - post] === y[y.length - 1 - post]) post++
  const hunks = myers(x.subarray(pre, x.length - post), y.subarray(pre, y.length - post))
  return hunks.map((h) => ({ aS: h.aS + pre, aE: h.aE + pre, bS: h.bS + pre, bE: h.bE + pre }))
}

/** Myers' O(ND) diff of two int arrays as hunks; past MAX_EDITS, one hunk over everything. */
function myers(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) return [{ aS: 0, aE: n, bS: 0, bE: m }]
  const max = n + m
  const limit = Math.min(max, MAX_EDITS)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d]: v before step d, diagonals -(d+1)..d+1 (index k + d + 1), what the walk back reads.
  const trace = []
  let found = -1
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let xx = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let yy = xx - k
      while (xx < n && yy < m && a[xx] === b[yy]) {
        xx++
        yy++
      }
      v[off + k] = xx
      if (xx >= n && yy >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return [{ aS: 0, aE: n, bS: 0, bE: m }]
  // Walk back from the end: each step is one deleted line of `a` or one inserted line of `b`.
  const ops = []
  let xx = n
  let yy = m
  for (let d = found; d > 0; d--) {
    const t = trace[d]
    const o = d + 1
    const k = xx - yy
    const down = k === -d || (k !== d && t[o + k - 1] < t[o + k + 1])
    const prevK = down ? k + 1 : k - 1
    const prevX = t[o + prevK]
    const prevY = prevX - prevK
    // down: b[prevY] inserted at a position prevX; right: a[prevX] deleted at b position prevY.
    ops.push(down ? { x: prevX, y: prevY, del: false } : { x: prevX, y: prevY, del: true })
    xx = prevX
    yy = prevY
  }
  ops.reverse()
  const hunks = []
  let cur = null
  for (const op of ops) {
    if (cur && cur.aE === op.x && cur.bE === op.y) {
      if (op.del) cur.aE++
      else cur.bE++
      continue
    }
    cur = { aS: op.x, aE: op.x + (op.del ? 1 : 0), bS: op.y, bE: op.y + (op.del ? 0 : 1) }
    hunks.push(cur)
  }
  return hunks
}

/** Offsets of each line start in the joined text, plus the total length at the end. */
function lineStarts(lines) {
  const out = new Array(lines.length + 1)
  let at = 0
  for (let i = 0; i < lines.length; i++) {
    out[i] = at
    at += lines[i].length
  }
  out[lines.length] = at
  return out
}

/**
 * The edits that turn `from` into `to`, whole lines at a time: `[{ from, to, insert }]` in offsets of
 * `from`, in order and not overlapping (CodeMirror's change spec). A reload applies these instead of
 * replacing the document, so the cursor, the selections and the scroll position map through the
 * change the way they would through typing, and the changed lines are known (to flash them).
 */
export function lineChanges(from, to) {
  if (from === to) return []
  const a = splitLines(from)
  const b = splitLines(to)
  const at = lineStarts(a)
  return diffLines(a, b).map((h) => ({ from: at[h.aS], to: at[h.aE], insert: b.slice(h.bS, h.bE).join('') }))
}

/**
 * Three-way merge of `mine` and `theirs`, both edited from `base`. Answers `{ chunks, conflicts }`:
 * chunks in order, each `{ ok: text }` (taken as is) or `{ base, mine, theirs }` (a conflict: the
 * region's text in each), and the number of conflicts.
 */
export function merge3(base, mine, theirs) {
  const o = splitLines(base)
  const a = splitLines(mine)
  const b = splitLines(theirs)
  const hunks = [
    ...diffLines(o, a).map((h) => ({ oS: h.aS, oE: h.aE, sS: h.bS, sE: h.bE, side: 'a' })),
    ...diffLines(o, b).map((h) => ({ oS: h.aS, oE: h.aE, sS: h.bS, sE: h.bE, side: 'b' })),
  ].sort((p, q) => p.oS - q.oS || p.oE - q.oE)
  const chunks = []
  const ok = (text) => {
    if (text === '') return
    const last = chunks[chunks.length - 1]
    if (last && 'ok' in last) last.ok += text
    else chunks.push({ ok: text })
  }
  let conflicts = 0
  let pos = 0
  let i = 0
  while (i < hunks.length) {
    const rs = hunks[i].oS
    let re = hunks[i].oE
    const group = [hunks[i++]]
    // Overlapping or touching (oS === re): one region. Two insertions at the same base line touch too.
    while (i < hunks.length && hunks[i].oS <= re) {
      re = Math.max(re, hunks[i].oE)
      group.push(hunks[i++])
    }
    ok(o.slice(pos, rs).join(''))
    // A side's text for the region [rs, re): its hunks' ranges, widened by the unchanged base lines
    // at either end (outside its hunks a side equals the base, line for line).
    const sideText = (side, lines) => {
      const hs = group.filter((h) => h.side === side)
      if (hs.length === 0) return null
      const first = hs[0]
      const last = hs[hs.length - 1]
      return lines.slice(first.sS - (first.oS - rs), last.sE + (re - last.oE)).join('')
    }
    const ta = sideText('a', a)
    const tb = sideText('b', b)
    if (tb === null) ok(ta)
    else if (ta === null || ta === tb) ok(tb) // theirs alone, or the same change made on both sides
    else {
      // Lines both sides carry at the region's edges (pulled in by touching hunks) are not in dispute:
      // they stay out of the conflict, or Keep both would write them twice.
      const la = splitLines(ta)
      const lb = splitLines(tb)
      let pre = 0
      while (pre < la.length && pre < lb.length && la[pre] === lb[pre]) pre++
      let suf = 0
      while (suf < la.length - pre && suf < lb.length - pre && la[la.length - 1 - suf] === lb[lb.length - 1 - suf]) suf++
      if (pre) ok(la.slice(0, pre).join(''))
      chunks.push({
        base: o.slice(rs, re).join(''),
        mine: la.slice(pre, la.length - suf).join(''),
        theirs: lb.slice(pre, lb.length - suf).join(''),
      })
      conflicts++
      if (suf) ok(la.slice(la.length - suf).join(''))
    }
    pos = re
  }
  ok(o.slice(pos).join(''))
  return { chunks, conflicts }
}

/** A conflict-free merge's text. */
export function mergedText(chunks) {
  return chunks.map((c) => ('ok' in c ? c.ok : c.mine)).join('')
}

/**
 * The buffer a merge with conflicts shows: the merged text with MY version in each conflict region,
 * and where each region is in it, `{ text, conflicts: [{ from, to, mine, theirs }] }`. Theirs is drawn
 * beside the region (file.js) until the person picks; the buffer stays plain text throughout, never
 * marker lines that a save could write.
 */
export function conflictLayout(chunks) {
  let text = ''
  const conflicts = []
  for (const c of chunks) {
    if ('ok' in c) {
      text += c.ok
      continue
    }
    conflicts.push({ from: text.length, to: text.length + c.mine.length, mine: c.mine, theirs: c.theirs })
    text += c.mine
  }
  return { text, conflicts }
}

/**
 * "Keep both" for a region holding `mine`: mine, then theirs, with a line break between when mine
 * does not end in one (its last line would run into theirs' first).
 */
export function keepBothText(mine, theirs) {
  if (mine === '' || theirs === '' || mine.endsWith('\n')) return mine + theirs
  return `${mine}\n${theirs}`
}
