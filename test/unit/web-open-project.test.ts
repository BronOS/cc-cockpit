// Server mode's open from the browser picker (main/web/open-project.ts, design-web.md §9.8): the
// POST body's check and what main does with it. The gateway's HTTP side is in web-gateway.test.ts;
// the real WindowManager behind openPath / openRecent in window-manager.test.ts.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_OPEN_PATH, openProjectFromWeb, parseOpenProjectBody, type OpenProjectDeps } from '../../src/main/web/open-project'

describe('parseOpenProjectBody', () => {
  it('takes exactly one of open and reopen, each a plain non-empty string', () => {
    expect(parseOpenProjectBody({ open: '/srv/app' })).toEqual({ open: '/srv/app' })
    expect(parseOpenProjectBody({ reopen: 'abc' })).toEqual({ reopen: 'abc' })
  })

  it('uses nothing else of the body', () => {
    expect(parseOpenProjectBody({ reopen: 'abc', path: '/etc', windowId: 3 })).toEqual({ reopen: 'abc' })
  })

  it('refuses both keys, neither, and anything that is not an object', () => {
    for (const body of [{ open: '/a', reopen: 'b' }, {}, { other: 1 }, null, [], 'x', 3, undefined]) {
      expect(parseOpenProjectBody(body), JSON.stringify(body)).toHaveProperty('error')
    }
  })

  it('refuses an empty, non-string, NUL-carrying or oversize value', () => {
    for (const body of [{ open: '' }, { reopen: '' }, { open: 3 }, { reopen: null }, { open: ['/a'] }, { open: '/a\0b' }, { open: `/${'a'.repeat(MAX_OPEN_PATH)}` }]) {
      expect(parseOpenProjectBody(body), JSON.stringify(body).slice(0, 40)).toHaveProperty('error')
    }
  })

  it('does not take an inherited key for an own one', () => {
    const proto = { open: '/inherited' }
    expect(parseOpenProjectBody(Object.create(proto) as unknown)).toHaveProperty('error')
  })
})

describe('openProjectFromWeb', () => {
  let root: string
  let calls: string[]
  let deps: OpenProjectDeps
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-open-'))
    calls = []
    deps = {
      openPath: (path) => {
        calls.push(`open ${path}`)
        return { id: 'p-new' }
      },
      openRecent: (id) => {
        calls.push(`reopen ${id}`)
        if (id === 'gone') throw new Error('project folder is missing: /old/gone')
        if (id !== 'r1') throw new Error('not a recent project')
        return { id: 'r1' }
      }
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('opens an existing folder by its resolved path', () => {
    const dir = join(root, 'app')
    mkdirSync(dir)
    expect(openProjectFromWeb({ open: `${root}/x/../app/` }, deps)).toEqual({ id: 'p-new' })
    expect(calls).toEqual([`open ${dir}`])
  })

  it('a link to a folder is a folder', () => {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(openProjectFromWeb({ open: join(root, 'link') }, deps)).toEqual({ id: 'p-new' })
  })

  it('refuses a relative path, a file and a path that is not there, creating nothing', () => {
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(openProjectFromWeb({ open: 'app' }, deps)).toEqual({ error: 'not an absolute path: app' })
    expect(openProjectFromWeb({ open: '~/app' }, deps)).toHaveProperty('error')
    expect(openProjectFromWeb({ open: join(root, 'file.txt') }, deps)).toEqual({ error: `not a folder: ${join(root, 'file.txt')}` })
    expect(openProjectFromWeb({ open: join(root, 'nope') }, deps)).toEqual({ error: `not a folder: ${join(root, 'nope')}` })
    expect(calls).toEqual([])
  })

  it('a failing open is its text, never a throw', () => {
    mkdirSync(join(root, 'app'))
    const failing: OpenProjectDeps = { ...deps, openPath: () => { throw new Error('cannot open a window') } }
    expect(openProjectFromWeb({ open: join(root, 'app') }, failing)).toEqual({ error: 'cannot open a window' })
  })

  it('reopens by id through the recent list only; an unknown id and a missing folder say so', () => {
    expect(openProjectFromWeb({ reopen: 'r1' }, deps)).toEqual({ id: 'r1' })
    expect(openProjectFromWeb({ reopen: 'nope' }, deps)).toEqual({ error: 'not a recent project' })
    expect(openProjectFromWeb({ reopen: 'gone' }, deps)).toEqual({ error: 'project folder is missing: /old/gone' })
    expect(calls).toEqual(['reopen r1', 'reopen nope', 'reopen gone'])
  })
})
