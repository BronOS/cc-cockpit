// The Notes service (task 03; shared/design.md §3, spec-review S2-S4): caps refuse and never cut, plugins never share a
// key, pushes reach only the copies main admits, and the store survives a restart and goes with its plugin or project.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesService } from '../../src/main/notes/notes-service'
import { notesFileName } from '../../src/main/notes/notes-store'
import { OverlayManager, type UrlView, type UrlViewFactory } from '../../src/main/overlays/overlay-manager'
import {
  MAX_GLOBAL_NOTE,
  MAX_NOTE_ANCHOR_JSON,
  MAX_NOTE_TEXT,
  MAX_NOTES,
  MAX_NOTES_JSON,
  MAX_NOTES_KEYS
} from '../../src/shared/notes-limits'
import type { NotesPush, EnvelopePush } from '../../src/shared/overlay-envelope'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const P1 = 'p1aaaaaaaaaaaaaa'
const P2 = 'p2bbbbbbbbbbbbbb'
const W1 = 1
const OWNER = { access: 'owner' } as const

class NoViews implements UrlViewFactory {
  create(): UrlView {
    throw new Error('no url overlays here')
  }
  focusWindow(): void {}
}

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-notes-service-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A service with no overlays to push to (window closed). */
function bare(): NotesService {
  return new NotesService({
    dataDir: dir,
    log: () => {},
    overlays: { overlaysWithNotes: () => [], copiesOf: () => [], postEnvelope: () => false, onCopyEnd: () => () => {} },
    windowOfProject: () => undefined
  })
}

const add = (s: NotesService, text: string, key = 'doc:1', pluginId = 'a.one', project = P1) =>
  s.add(project, pluginId, key, { quote: 'q', anchor: null, text }, OWNER)

describe('notes service', () => {
  it('an add past 200 notes, 4,000 characters, the global\'s 4,000, 400,000 JSON or 1,000 keys is refused, never cut', async () => {
    const s = bare()
    // One note's text, the global note, the anchor.
    await expect(add(s, 'x'.repeat(MAX_NOTE_TEXT + 1))).rejects.toThrow(/at most 4,000 characters/)
    await expect(s.setGlobal(P1, 'a.one', 'doc:1', 'g'.repeat(MAX_GLOBAL_NOTE + 1))).rejects.toThrow(/at most 4,000/)
    await expect(s.add(P1, 'a.one', 'doc:1', { quote: '', anchor: { a: 'z'.repeat(MAX_NOTE_ANCHOR_JSON) }, text: 't' }, OWNER)).rejects.toThrow(/anchor/)
    expect((await s.list(P1, 'a.one', 'doc:1')).notes).toEqual([])
    // A change past the text cap is refused too, the note left as it was.
    const first = await add(s, 'kept')
    await expect(s.change(P1, 'a.one', 'doc:1', first.note!.id, 'y'.repeat(MAX_NOTE_TEXT + 1))).rejects.toThrow(/at most/)
    expect((await s.list(P1, 'a.one', 'doc:1')).notes.map((n) => n.text)).toEqual(['kept'])
    // 200 notes, then one more.
    for (let i = 1; i < MAX_NOTES; i++) await add(s, `n${i}`)
    await expect(add(s, 'one too many')).rejects.toThrow(/at most 200 notes/)
    expect((await s.list(P1, 'a.one', 'doc:1')).notes).toHaveLength(MAX_NOTES)
    // The whole store's JSON: notes of 3,900 characters on another key pass 400,000 before 200 notes.
    const big = 'b'.repeat(3900)
    let refused: unknown
    for (let i = 0; i < 200 && refused === undefined; i++) await add(s, big, 'doc:big').catch((e: unknown) => (refused = e))
    expect(String(refused)).toMatch(/400,000 characters in all/)
    const left = await s.list(P1, 'a.one', 'doc:big')
    expect(JSON.stringify({ global: left.global, notes: left.notes, rev: left.rev }).length).toBeLessThanOrEqual(MAX_NOTES_JSON)
    expect(left.notes.every((n) => n.text === big)).toBe(true)
  })

  it('1,000 keys per (project, plugin); another plugin or project is apart', async () => {
    const s = bare()
    for (let i = 0; i < MAX_NOTES_KEYS; i++) await s.setGlobal(P1, 'a.one', `k${i}`, 'g')
    await expect(add(s, 'x', 'k-new')).rejects.toThrow(/at most 1,000 documents/)
    await expect(s.setGlobal(P1, 'a.one', 'k-new', 'g')).rejects.toThrow(/at most 1,000 documents/)
    // An existing key still takes notes; another plugin and another project have their own count.
    await expect(add(s, 'x', 'k1')).resolves.toBeDefined()
    await expect(add(s, 'x', 'k-new', 'b.two')).resolves.toBeDefined()
    await expect(add(s, 'x', 'k-new', 'a.one', P2)).resolves.toBeDefined()
  }, 30_000)

  it('two plugins with one key don\'t share', async () => {
    const s = bare()
    await add(s, 'from a', 'doc:1', 'a.one')
    await s.setGlobal(P1, 'b.two', 'doc:1', 'from b')
    expect((await s.list(P1, 'a.one', 'doc:1')).notes.map((n) => n.text)).toEqual(['from a'])
    expect((await s.list(P1, 'a.one', 'doc:1')).global).toBe('')
    expect((await s.list(P1, 'b.two', 'doc:1')).notes).toEqual([])
    expect((await s.list(P1, 'b.two', 'doc:1')).global).toBe('from b')
  })

  it('a change bumps the note\'s rev and keeps its author; every write bumps seq', async () => {
    const s = bare()
    const a = await s.add(P1, 'a.one', 'k', { quote: '', anchor: null, text: 'a' }, { access: 'write', person: 'Ann' })
    const c = await s.change(P1, 'a.one', 'k', a.note!.id, 'b')
    expect(c.note).toMatchObject({ rev: 2, text: 'b', author: { access: 'write', person: 'Ann' } })
    expect(c.seq).toBeGreaterThan(a.seq)
    expect((await s.list(P1, 'a.one', 'k')).seq).toBe(c.seq)
    await expect(s.change(P1, 'a.one', 'k', 'gone', 'x')).rejects.toThrow(/gone/)
    await expect(s.add(P1, 'a.one', 'k', { quote: '', anchor: null, text: 'x' }, { access: 'nobody' } as never)).rejects.toThrow(/no author/)
  })

  it('removeSent removes only the notes still at their sent rev, and the note for Claude while unchanged', async () => {
    const s = bare()
    const a = await add(s, 'a')
    const b = await add(s, 'b')
    await s.setGlobal(P1, 'a.one', 'doc:1', 'g')
    await s.change(P1, 'a.one', 'doc:1', b.note!.id, 'b2')
    await s.removeSent(P1, 'a.one', 'doc:1', { global: 'g', notes: [{ id: a.note!.id, rev: 1 }, { id: b.note!.id, rev: 1 }] })
    const left = await s.list(P1, 'a.one', 'doc:1')
    expect(left.notes.map((n) => n.text)).toEqual(['b2'])
    expect(left.global).toBe('')
  })

  it('survives restart', async () => {
    const s = bare()
    const a = await s.add(P1, 'a.one', '__proto__', { quote: 'q', anchor: { line: 3 }, text: 'kept' }, OWNER)
    await s.setGlobal(P1, 'a.one', '__proto__', 'for Claude')
    const again = bare()
    const listed = await again.list(P1, 'a.one', '__proto__')
    expect(listed.global).toBe('for Claude')
    expect(listed.notes).toEqual([{ ...a.note, anchor: { line: 3 } }])
  })

  it('an emptied key leaves no file behind; an unreadable file is moved aside, never written over', async () => {
    const s = bare()
    const a = await add(s, 'a')
    const projectDir = join(dir, 'notes', P1)
    expect(readdirSync(projectDir)).toEqual([notesFileName('a.one')])
    await s.remove(P1, 'a.one', 'doc:1', a.note!.id)
    expect(existsSync(projectDir)).toBe(false)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, notesFileName('a.one')), '{not json')
    const fresh = bare()
    expect((await fresh.list(P1, 'a.one', 'doc:1')).notes).toEqual([])
    expect(readdirSync(projectDir).some((f) => f.includes('.unreadable-'))).toBe(true)
  })

  it('dropped with the plugin', async () => {
    const s = bare()
    await add(s, 'a', 'doc:1', 'a.one', P1)
    await add(s, 'a', 'doc:1', 'a.one', P2)
    await add(s, 'b', 'doc:1', 'b.two', P1)
    s.removePlugin('a.one')
    await s.idle()
    expect((await bare().list(P1, 'a.one', 'doc:1')).notes).toEqual([])
    expect((await bare().list(P2, 'a.one', 'doc:1')).notes).toEqual([])
    expect((await s.list(P1, 'a.one', 'doc:1')).notes).toEqual([])
    expect((await bare().list(P1, 'b.two', 'doc:1')).notes).toHaveLength(1)
  })

  it('dropped with the project', async () => {
    const s = bare()
    await add(s, 'a', 'doc:1', 'a.one', P1)
    await add(s, 'a', 'doc:1', 'a.one', P2)
    s.dropProject(P1)
    await s.idle()
    expect(existsSync(join(dir, 'notes', P1))).toBe(false)
    expect((await s.list(P1, 'a.one', 'doc:1')).notes).toEqual([])
    expect((await bare().list(P2, 'a.one', 'doc:1')).notes).toHaveLength(1)
  })

  it('refuses a key or project id that is not one', async () => {
    const s = bare()
    await expect(add(s, 'x', 'has space')).rejects.toThrow(/not a notes key/)
    await expect(add(s, 'x', 'doc:1', 'a.one', '../up')).rejects.toThrow(/not a project id/)
  })
})

describe('notes pushes', () => {
  /** A real manager: an owner's view, a guest main admits (web:6), a guest it no longer does (web:5). */
  function withOverlays() {
    const admitted = new Set(['web:5', 'web:6'])
    const pushes: Array<{ viewId: string; copy?: string; push: EnvelopePush<'notes'> }> = []
    const m = new OverlayManager({
      ownerView: (v) => v === 'web:1' || v === 'desktop:1',
      backend: new FakePtyBackend(),
      views: new NoViews(),
      isWindowOpen: () => true,
      env: () => ({}),
      emit: () => {},
      emitToView: (viewId, channel, payload) => {
        const p = payload as { envelope?: true; copy?: string; message: string }
        if (channel === 'overlays.message' && p.envelope === true) pushes.push({ viewId, copy: p.copy, push: JSON.parse(p.message) })
        return true
      },
      isViewLive: () => true,
      guestOf: (v) => (v.startsWith('web:') && v !== 'web:1' ? `g-${v}` : undefined),
      mayConnectCopy: (_w, _o, v) => admitted.has(v),
      commandForChord: () => undefined,
      log: () => {}
    })
    const s = new NotesService({ dataDir: dir, log: () => {}, overlays: m, windowOfProject: (p) => (p === P1 ? W1 : undefined) })
    const open = (pluginId: string, key: string): string => {
      void m
        .open(W1, { kind: 'html', src: `cc-plugin://${pluginId}/d.html`, title: 'D', notes: { key } }, `plugin ${pluginId}`, undefined, { onMessage: () => {} }, pluginId, undefined, undefined, { perView: true })
        .catch(() => undefined)
      return m.infos(W1).at(-1)!.id
    }
    const ready = (id: string, v: string): string => {
      const a = m.connectReady(W1, id, v)
      if (!('copy' in a)) throw new Error(a.refused)
      return a.copy
    }
    return { m, s, admitted, pushes, open, ready }
  }

  it('deltas only to copies main admits (mayConnectCopy, via)', async () => {
    const t = withOverlays()
    const one = t.open('a.one', 'doc:1')
    const other = t.open('b.two', 'doc:1')
    const own = t.ready(one, 'web:1')
    const g6 = t.ready(one, 'web:6')
    t.ready(one, 'web:5')
    t.ready(other, 'web:1')
    // web:5 was admitted at connect and is no longer (its plugin hidden from that guest, or a via plugin added).
    t.admitted.delete('web:5')
    const w = await add(t.s, 'hello')
    expect(t.pushes.map((p) => [p.viewId, p.copy])).toEqual([
      ['web:1', own],
      ['web:6', g6]
    ])
    const data: NotesPush = t.pushes[0]!.push.data
    expect(t.pushes[0]!.push).toMatchObject({ $cc: 1, ev: 'notes', seq: w.seq })
    expect(data.state.notes.map((n) => n.text)).toEqual(['hello'])
    // Another project's write, or the window closed: nothing.
    t.pushes.length = 0
    await add(t.s, 'elsewhere', 'doc:1', 'a.one', P2)
    expect(t.pushes).toEqual([])
  })
})
