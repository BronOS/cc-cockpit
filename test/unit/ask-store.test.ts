// Task 02 (ask-store.ts, D14): the owner's kept chats per (project, plugin, notes key) in <data>/ask.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskStore, capTurns } from '../../src/main/ask/ask-store'
import { ASK_STORE_MAX_KEYS } from '../../src/shared/ask'

const P = 'aaaaaaaaaaaaaaaa'
const Q = 'bbbbbbbbbbbbbbbb'
const SESSION = '11111111-2222-3333-4444-555555555555'
let dir: string
let clock: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-ask-store-'))
  clock = 1
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = (): AskStore => new AskStore(dir, () => {}, () => clock++)
const turn = { question: 'q', answer: 'a' }

describe('AskStore', () => {
  it('the store survives a restart', () => {
    store().put(P, 'a.jira', { key: 'jira:PROJ-1', sessionId: SESSION, turns: [turn], model: 'opus' })
    expect(store().get(P, 'a.jira', 'jira:PROJ-1')).toMatchObject({ key: 'jira:PROJ-1', sessionId: SESSION, turns: [turn], model: 'opus' })
    expect(store().get(P, 'b.other', 'jira:PROJ-1')).toBeUndefined()
  })

  it('a non-UUID session id is never stored', () => {
    store().put(P, 'a.jira', { key: 'k', sessionId: '--settings=/tmp/x', turns: [turn] })
    expect(store().get(P, 'a.jira', 'k')?.sessionId).toBeUndefined()
  })

  it('a key such as __proto__ stays data', () => {
    store().put(P, 'a.jira', { key: '__proto__', turns: [turn] })
    expect(store().get(P, 'a.jira', '__proto__')?.turns).toEqual([turn])
    expect(({} as Record<string, unknown>).turns).toBeUndefined()
  })

  it('dropped with the plugin and the project', () => {
    const s = store()
    s.put(P, 'a.jira', { key: 'k', turns: [turn] })
    s.put(Q, 'a.jira', { key: 'k', turns: [turn] })
    s.put(P, 'b.gmail', { key: 'k', turns: [turn] })
    s.removePlugin('a.jira')
    expect(store().get(P, 'a.jira', 'k')).toBeUndefined()
    expect(store().get(Q, 'a.jira', 'k')).toBeUndefined()
    expect(store().get(P, 'b.gmail', 'k')).toBeDefined()
    s.dropProject(P)
    expect(existsSync(join(dir, 'ask', P))).toBe(false)
    expect(store().get(P, 'b.gmail', 'k')).toBeUndefined()
  })

  it('a project id that is not a plain segment is never a folder', () => {
    store().put('../evil', 'a.jira', { key: 'k', turns: [turn] })
    expect(readdirSync(dir)).toEqual([])
  })

  it('caps: the oldest turns go first; past the key cap the least recently used key goes', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({ question: 'q' + i, answer: 'x'.repeat(100) }))
    const capped = capTurns(turns, 2000)
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(2000)
    expect(capped.at(-1)).toEqual(turns.at(-1))
    const s = store()
    for (let i = 0; i <= ASK_STORE_MAX_KEYS; i++) s.put(P, 'a.jira', { key: 'k' + i, turns: [] })
    expect(s.get(P, 'a.jira', 'k0')).toBeUndefined()
    expect(s.get(P, 'a.jira', 'k1')).toBeDefined()
    expect(s.get(P, 'a.jira', 'k' + ASK_STORE_MAX_KEYS)).toBeDefined()
  })
})
