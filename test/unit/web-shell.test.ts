// The web shell, part 2 (plan Task 8): which build files the gateway serves (main/web/shell-files.ts),
// the sign-in step (renderer/web/sign-in.ts), the project picker's list (renderer/web/picker.tsx,
// main/web/connection.ts openProjectEntries) and the window chrome the web shell leaves out
// (renderer/shell-kind.ts). The gateway's HTTP side of the same is in web-gateway.test.ts.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openProjectEntries } from '../../src/main/web/connection'
import { shellFileOf } from '../../src/main/web/shell-files'
import { armLoadTab, armLoadTake, currentShellChrome, isWebShell, markWebShell, resetShellKindForTest, showsThisComputerChip, takeLoadTab, takeLoadTake } from '../../src/renderer/shell-kind'
import { desktopAgentSuffix } from '../../src/shared/remote-agent'
import { topStripClass } from '../../src/renderer/status/strip-order'
import {
  breadcrumbs,
  childPath,
  commonPrefix,
  completions,
  completionTarget,
  expandHome,
  filterFolders,
  loadFolders,
  loadOpenProjects,
  openProject,
  projectHref,
  takeTabParam
} from '../../src/renderer/web/picker-model'
import {
  askConfirm,
  confirmPollOf,
  deviceName,
  linkTokenOf,
  pollConfirm,
  sessionReplyOf,
  shownCode,
  signedOutText,
  signIn,
  signInWithPassword,
  type SignInEnv
} from '../../src/renderer/web/sign-in'
import {
  CONFIRM_ASK_PATH,
  CONFIRM_POLL_PATH,
  FOLDERS_PATH,
  MAX_FOLDER_ENTRIES,
  PROJECTS_PATH,
  SESSION_PATH,
  SIGN_IN_LINK_PATH,
  SIGN_IN_PASSWORD_PATH,
  type WebFolderEntry
} from '../../src/shared/web-protocol'

describe('shellFileOf', () => {
  const root = '/app/out/renderer'
  it('maps / to the web page and a plain asset name to assets/', () => {
    expect(shellFileOf(root, '/')).toEqual({ path: join(root, 'web', 'index.html'), type: 'text/html; charset=utf-8', immutable: false })
    expect(shellFileOf(root, '/assets/web-abc.js')).toEqual({ path: join(root, 'assets', 'web-abc.js'), type: 'text/javascript; charset=utf-8', immutable: true })
    expect(shellFileOf(root, '/assets/Font-1.WOFF2')?.type).toBe('font/woff2')
    expect(shellFileOf(root, '/assets/a%20b.css')?.path).toBe(join(root, 'assets', 'a b.css'))
  })

  it('names nothing outside the two places, and no other kind of file', () => {
    for (const path of [
      '/index.html',
      '/web/index.html',
      '/main/index.js',
      '/preload/index.js',
      '/assets/',
      '/assets/../index.html',
      '/assets/..%2F..%2Fmain%2Findex.js',
      '/assets/..%5Cindex.js',
      '/assets/a/b.js',
      '/assets/.env.js',
      '/assets/x.html',
      '/assets/x.js.map',
      '/assets/x.json',
      '/assets/x',
      '/assets/x%00.js',
      '/assets/%E0%A4%A',
      '//assets/x.js',
      '/Assets/x.js'
    ]) {
      expect(shellFileOf(root, path), path).toBeUndefined()
    }
  })
})

type SessionAnswer = { status: number; body: unknown } | 'throw'

/** A scripted gateway for the sign-in step; records what the page asked and where the URL went. */
function env(opts: {
  hash?: string
  search?: string
  link?: { status: number; body: unknown } | 'throw'
  /** The SESSION_PATH answer; a list answers in turn (the last one repeats). */
  session?: SessionAnswer | SessionAnswer[]
}): { env: SignInEnv; calls: Array<{ url: string; init?: unknown }>; urls: string[]; order: string[] } {
  const calls: Array<{ url: string; init?: unknown }> = []
  const urls: string[] = []
  const order: string[] = []
  const sessions = Array.isArray(opts.session) ? [...opts.session] : [opts.session]
  const answer = (a: { status: number; body: unknown } | 'throw' | undefined) => {
    if (a === 'throw' || a === undefined) throw new TypeError('Failed to fetch')
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body }
  }
  return {
    calls,
    urls,
    order,
    env: {
      location: { hash: opts.hash ?? '', pathname: '/', search: opts.search ?? '' },
      replaceUrl: (url) => {
        urls.push(url)
        order.push('replace')
      },
      fetch: async (url, init) => {
        calls.push({ url, ...(init ? { init } : {}) })
        order.push(url)
        if (url === SIGN_IN_LINK_PATH) return answer(opts.link)
        return answer(sessions.length > 1 ? sessions.shift() : sessions[0])
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
    }
  }
}

const signedIn = { status: 200, body: { mode: 'link', device: { id: 'd1', name: 'Chrome on Android' } } }
const signedOut = { status: 200, body: { mode: 'link', device: null } }

describe('the sign-in step', () => {
  it('reads #t=, clears the URL, checks it is signed out, posts the link once, and is signed in', async () => {
    const s = env({ hash: '#t=tok_123', search: '?project=abc', link: { status: 200, body: {} }, session: [signedOut, signedIn] })
    const state = await signIn(s.env)
    expect(state).toEqual({ state: 'signed-in', device: { id: 'd1', name: 'Chrome on Android' } })
    // The token leaves the address bar (and history) first; the project stays.
    expect(s.urls).toEqual(['/?project=abc'])
    expect(s.order).toEqual(['replace', SESSION_PATH, SIGN_IN_LINK_PATH, SESSION_PATH])
    const post = s.calls[1]!
    expect(post.init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' })
    expect(JSON.parse((post.init as { body: string }).body)).toEqual({ token: 'tok_123', name: 'Chrome on Android' })
    expect(s.calls.filter((c) => c.url === SIGN_IN_LINK_PATH)).toHaveLength(1)
  })

  it('with no link, only asks whether this browser is signed in', async () => {
    const s = env({ session: signedIn })
    expect((await signIn(s.env)).state).toBe('signed-in')
    expect(s.urls).toEqual([])
    expect(s.calls.map((c) => c.url)).toEqual([SESSION_PATH])
  })

  it('a link that does not work: signed out with the gateway\'s reason, and the URL is still cleared', async () => {
    const s = env({ hash: '#t=old', link: { status: 401, body: { error: 'this link does not work any more' } }, session: signedOut })
    expect(await signIn(s.env)).toEqual({ state: 'signed-out', mode: 'link', error: 'this link does not work any more' })
    expect(s.urls).toEqual(['/'])
  })

  it('a post that throws or answers without a reason still ends in a plain error', async () => {
    expect(await signIn(env({ hash: '#t=x', link: 'throw', session: signedOut }).env)).toEqual({
      state: 'signed-out',
      mode: 'link',
      error: 'the host did not answer the sign-in'
    })
    expect(await signIn(env({ hash: '#t=x', link: { status: 429, body: 'nope' }, session: signedOut }).env)).toEqual({
      state: 'signed-out',
      mode: 'link',
      error: 'sign-in failed (429)'
    })
  })

  it('a link opened on a browser that is already signed in is cleared and never posted', async () => {
    // Posting it would add a second device (a "new device" notice, a place under the cap) every
    // time the QR is scanned again, and use up a one-time "add a device" token for nothing.
    const s = env({ hash: '#t=again', link: { status: 200, body: {} }, session: signedIn })
    expect((await signIn(s.env)).state).toBe('signed-in')
    expect(s.urls).toEqual(['/'])
    expect(s.order).toEqual(['replace', SESSION_PATH])
  })

  it('a link with the host unreachable is cleared and not posted', async () => {
    const s = env({ hash: '#t=tok', link: { status: 200, body: {} }, session: 'throw' })
    expect((await signIn(s.env)).state).toBe('unreachable')
    expect(s.urls).toEqual(['/'])
    expect(s.calls.map((c) => c.url)).toEqual([SESSION_PATH])
  })

  it('any other fragment is cleared and not posted', async () => {
    const s = env({ hash: '#x=1', session: signedOut })
    expect(await signIn(s.env)).toEqual({ state: 'signed-out', mode: 'link' })
    expect(s.urls).toEqual(['/'])
    expect(s.calls.map((c) => c.url)).toEqual([SESSION_PATH])
  })

  it('a host that does not answer, or answers something else, is unreachable', async () => {
    expect((await signIn(env({ session: 'throw' }).env)).state).toBe('unreachable')
    expect((await signIn(env({ session: { status: 502, body: {} } }).env)).state).toBe('unreachable')
    expect((await signIn(env({ session: { status: 200, body: { mode: 'other', device: null } } }).env)).state).toBe('unreachable')
  })

  it('reads the token from the fragment only when it is one', () => {
    expect(linkTokenOf('#t=abc')).toBe('abc')
    expect(linkTokenOf('#t=a%2Bb')).toBe('a+b')
    expect(linkTokenOf('#t=')).toBeUndefined()
    expect(linkTokenOf('')).toBeUndefined()
    expect(linkTokenOf('t=abc')).toBeUndefined()
    expect(linkTokenOf(`#t=${'a'.repeat(600)}`)).toBeUndefined()
  })

  it('checks the session answer', () => {
    expect(sessionReplyOf({ mode: 'none', device: null })).toEqual({ mode: 'none', device: null })
    expect(sessionReplyOf({ mode: 'link', device: { id: 'a', name: 'b', extra: 1 } })).toEqual({ mode: 'link', device: { id: 'a', name: 'b' } })
    expect(sessionReplyOf({ mode: 'link' })).toBeUndefined()
    expect(sessionReplyOf({ mode: 'link', device: { id: 1 } })).toBeUndefined()
    expect(sessionReplyOf(null)).toBeUndefined()
  })

  it('names the device by browser and system', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS')
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Firefox on Linux')
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows')
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on macOS')
    expect(deviceName('curl/8')).toBe('Browser')
  })

  it('names a cc-cockpit desktop window by its hostname, within the server cap of 60', () => {
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36 cc-cockpit-desktop/0.17.0 (laptop)')).toBe('cc-cockpit desktop on laptop')
    const long = deviceName(`Chrome/130.0 cc-cockpit-desktop/0.17.0 (${'h'.repeat(64)})`)
    expect(long).toBe(`cc-cockpit desktop on ${'h'.repeat(38)}`)
    expect(long).toHaveLength(60)
    expect(deviceName('Chrome/130.0 Safari/537.36 cc-cockpit-desktop/0.17.0')).toBe('Chrome')
  })

  it('says what to do when signed out, per mode', () => {
    expect(signedOutText('link')).toMatch(/access link/)
    expect(signedOutText('password')).toMatch(/password/)
    expect(signedOutText('confirm')).toMatch(/code/)
    for (const mode of ['password', 'confirm', 'none'] as const) expect(signedOutText(mode)).not.toMatch(/not available/)
  })
})

describe('password and desktop-confirm sign-in (plan Task 27)', () => {
  const UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
  function fetcher(answers: Record<string, { status: number; body: unknown } | 'throw'>): {
    env: Pick<SignInEnv, 'fetch' | 'userAgent'>
    calls: Array<{ url: string; body: unknown }>
  } {
    const calls: Array<{ url: string; body: unknown }> = []
    return {
      calls,
      env: {
        userAgent: UA,
        fetch: async (url, init) => {
          calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
          const a = answers[url]
          if (a === undefined || a === 'throw') throw new Error('offline')
          return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body }
        }
      }
    }
  }

  it('posts the password with the device name; the gateway\'s reason on a refusal', async () => {
    const ok = fetcher({ [SIGN_IN_PASSWORD_PATH]: { status: 200, body: { device: { id: 'd', name: 'x' } } } })
    expect(await signInWithPassword(ok.env, 'hunter22hunter')).toBeUndefined()
    expect(ok.calls).toEqual([{ url: SIGN_IN_PASSWORD_PATH, body: { password: 'hunter22hunter', name: 'Chrome on Android' } }])
    expect(await signInWithPassword(fetcher({ [SIGN_IN_PASSWORD_PATH]: { status: 401, body: { error: 'wrong password' } } }).env, 'x')).toBe('wrong password')
    expect(await signInWithPassword(fetcher({}).env, 'x')).toBe('the host did not answer the sign-in')
  })

  it('asks for a confirm: the code and ticket, or why not', async () => {
    const ticket = { code: '012345', ticket: 'T'.repeat(43), expiresAt: 5 }
    const ok = fetcher({ [CONFIRM_ASK_PATH]: { status: 200, body: ticket } })
    expect(await askConfirm(ok.env)).toEqual({ ok: true, ticket })
    expect(ok.calls[0]).toEqual({ url: CONFIRM_ASK_PATH, body: { name: 'Chrome on Android' } })
    expect(await askConfirm(fetcher({ [CONFIRM_ASK_PATH]: { status: 409, body: { error: 'another browser is waiting' } } }).env)).toEqual({
      ok: false,
      error: 'another browser is waiting'
    })
    expect(await askConfirm(fetcher({ [CONFIRM_ASK_PATH]: { status: 200, body: { code: 5 } } }).env)).toEqual({ ok: false, error: 'the host answered something else' })
  })

  it('polls with the ticket and reads every answer; a failed poll is an error to retry', async () => {
    const pending = fetcher({ [CONFIRM_POLL_PATH]: { status: 200, body: { state: 'pending', code: '012345', expiresAt: 9 } } })
    expect(await pollConfirm(pending.env, 'tick')).toEqual({ state: 'pending', code: '012345', expiresAt: 9 })
    expect(pending.calls[0]).toEqual({ url: CONFIRM_POLL_PATH, body: { ticket: 'tick' } })
    expect(await pollConfirm(fetcher({ [CONFIRM_POLL_PATH]: { status: 200, body: { state: 'denied' } } }).env, 't')).toEqual({ state: 'denied' })
    expect(await pollConfirm(fetcher({ [CONFIRM_POLL_PATH]: { status: 503, body: { error: 'too many devices' } } }).env, 't')).toEqual({
      state: 'error',
      error: 'too many devices'
    })
    expect(await pollConfirm(fetcher({}).env, 't')).toEqual({ state: 'error', error: 'the host did not answer' })
    expect(confirmPollOf({ state: 'allowed', device: { id: 'd', name: 'n' } })).toEqual({ state: 'allowed', device: { id: 'd', name: 'n' } })
    expect(confirmPollOf({ state: 'gone' })).toEqual({ state: 'gone' })
    expect(confirmPollOf({ state: 'allowed' })).toBeUndefined()
    expect(confirmPollOf({ state: 'pending' })).toBeUndefined()
    expect(confirmPollOf('x')).toBeUndefined()
  })

  it('shows the code in two halves', () => {
    expect(shownCode('012345')).toBe('012 345')
    expect(shownCode('12')).toBe('12')
  })
})

describe('the project picker', () => {
  const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })

  it('lists what the gateway says is open, as plain entries', async () => {
    const fetchFn = vi.fn(answer(200, { projects: [{ id: 'p1', name: 'one', path: '/w/one' }, { id: '', name: 'x', path: '/' }, 'junk', { id: 'p2', name: 'two', path: '/w/two', more: 1 }] }))
    expect(await loadOpenProjects(fetchFn)).toEqual({
      ok: true,
      projects: [
        { id: 'p1', name: 'one', path: '/w/one' },
        { id: 'p2', name: 'two', path: '/w/two' }
      ],
      server: false,
      recent: []
    })
    expect(fetchFn).toHaveBeenCalledWith(PROJECTS_PATH, { credentials: 'same-origin', cache: 'no-store' })
  })

  it('server mode: the recent projects too, a missing one marked; recent without server is ignored', async () => {
    const recent = [{ id: 'r1', name: 'one', path: '/w/one', missing: false }, { id: 'r2', name: 'gone', path: '/w/gone', missing: true }, { id: 'r3', name: 'x', path: '/x', missing: 'yes' }, 7]
    expect(await loadOpenProjects(answer(200, { projects: [], server: true, recent }))).toEqual({
      ok: true,
      projects: [],
      server: true,
      recent: [
        { id: 'r1', name: 'one', path: '/w/one', missing: false },
        { id: 'r2', name: 'gone', path: '/w/gone', missing: true },
        { id: 'r3', name: 'x', path: '/x', missing: false }
      ]
    })
    expect(await loadOpenProjects(answer(200, { projects: [], recent }))).toMatchObject({ server: false, recent: [] })
    expect(await loadOpenProjects(answer(200, { projects: [], server: true, recent: 'x' }))).toMatchObject({ server: true, recent: [] })
  })

  it('opens by path or recent id with a JSON POST; the id, the host\'s error text, signed out, or no answer', async () => {
    const fetchFn = vi.fn(answer(200, { id: 'p9' }))
    expect(await openProject(fetchFn, { open: '/srv/app' })).toEqual({ ok: true, id: 'p9' })
    expect(fetchFn).toHaveBeenCalledWith(PROJECTS_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{"open":"/srv/app"}'
    })
    expect(await openProject(answer(400, { error: 'not a folder: /srv/x' }), { open: '/srv/x' })).toEqual({
      ok: false,
      signedOut: false,
      error: 'not a folder: /srv/x'
    })
    expect(await openProject(answer(401, {}), { reopen: 'r1' })).toEqual({ ok: false, signedOut: true })
    // Off server mode the gateway's 404 is plain text: the status, not a throw.
    const notJson = async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('x') } })
    expect(await openProject(notJson, { reopen: 'r1' })).toEqual({ ok: false, signedOut: false, error: 'the host answered 404' })
    expect(await openProject(answer(200, { id: '' }), { reopen: 'r1' })).toEqual({ ok: false, signedOut: false, error: 'the host answered 200' })
    expect(
      await openProject(async () => {
        throw new TypeError('Failed to fetch')
      }, { reopen: 'r1' })
    ).toEqual({ ok: false, signedOut: false, error: 'the host did not answer' })
  })

  it('a 401 means signed out; anything else is an error, never a throw', async () => {
    expect(await loadOpenProjects(answer(401, {}))).toEqual({ ok: false, signedOut: true })
    expect(await loadOpenProjects(answer(500, {}))).toMatchObject({ ok: false, signedOut: false })
    expect(await loadOpenProjects(answer(200, { projects: 'x' }))).toMatchObject({ ok: false, signedOut: false })
    expect(
      await loadOpenProjects(async () => {
        throw new TypeError('Failed to fetch')
      })
    ).toEqual({ ok: false, signedOut: false, error: 'the host did not answer' })
  })

  it('links each project to the shell bound to it, on the page\'s own origin', () => {
    expect(projectHref('abc123')).toBe('?project=abc123')
    expect(projectHref('a&b=c')).toBe('?project=a%26b%3Dc')
    // Server mode's `project.goto`: the tab to select there rides along.
    expect(projectHref('abc123', 't-1')).toBe('?project=abc123&tab=t-1')
    expect(projectHref('abc123', 'a&b')).toBe('?project=abc123&tab=a%26b')
    expect(projectHref('abc123', '')).toBe('?project=abc123')
  })

  it("takes `?tab=` once: the tab, and the address without it (other params and the fragment kept)", () => {
    expect(takeTabParam('https://h/x/?project=p1&tab=t1#t=tok')).toEqual({ tabId: 't1', url: 'https://h/x/?project=p1#t=tok' })
    expect(takeTabParam('https://h/?tab=a%26b&project=p1')).toEqual({ tabId: 'a&b', url: 'https://h/?project=p1' })
    // No param: nothing to replace.
    expect(takeTabParam('https://h/?project=p1')).toBeUndefined()
    // Empty or too long: no tab, but still dropped from the address.
    expect(takeTabParam('https://h/?project=p1&tab=')).toEqual({ tabId: undefined, url: 'https://h/?project=p1' })
    expect(takeTabParam(`https://h/?project=p1&tab=${'x'.repeat(201)}`)).toEqual({ tabId: undefined, url: 'https://h/?project=p1' })
    expect(takeTabParam('not a url')).toBeUndefined()
  })

  it('main lists only projects with a window open, never the registry\'s others', () => {
    const records = new Map([
      ['p1', { id: 'p1', name: 'one', path: '/w/one', enabledPlugins: ['x'] }],
      ['p2', { id: 'p2', name: 'two', path: '/w/two', enabledPlugins: [] }],
      ['p3', { id: 'p3', name: 'closed', path: '/w/closed', enabledPlugins: [] }]
    ])
    const windows = { projectWindows: () => [{ projectId: 'p2' }, { projectId: 'p1' }, { projectId: 'gone' }] }
    expect(openProjectEntries(windows, (id) => records.get(id))).toEqual([
      { id: 'p2', name: 'two', path: '/w/two' },
      { id: 'p1', name: 'one', path: '/w/one' }
    ])
    expect(openProjectEntries({ projectWindows: () => [] }, (id) => records.get(id))).toEqual([])
  })

  it('server mode: the colour (checked again), when each was last opened and which server it is', async () => {
    const body = {
      projects: [{ id: 'p1', name: 'one', path: '/w/one', color: 'teal' }, { id: 'p2', name: 'two', path: '/w/two', color: 'red; background: url(x)' }],
      server: true,
      recent: [{ id: 'r1', name: 'r', path: '/w/r', missing: false, color: '#a1b2c3', lastOpenedAt: 12 }, { id: 'r2', name: 's', path: '/w/s', missing: true, lastOpenedAt: 'x' }],
      host: { name: 'box', user: 'me', home: '/home/me', extra: 1 }
    }
    expect(await loadOpenProjects(answer(200, body))).toEqual({
      ok: true,
      projects: [
        { id: 'p1', name: 'one', path: '/w/one', color: 'teal' },
        { id: 'p2', name: 'two', path: '/w/two' }
      ],
      server: true,
      recent: [
        { id: 'r1', name: 'r', path: '/w/r', missing: false, color: '#a1b2c3', lastOpenedAt: 12 },
        { id: 'r2', name: 's', path: '/w/s', missing: true }
      ],
      host: { name: 'box', user: 'me', home: '/home/me' }
    })
    // A host off server mode, or a damaged one, is left out.
    expect(await loadOpenProjects(answer(200, { projects: [], host: body.host }))).not.toHaveProperty('host')
    expect(await loadOpenProjects(answer(200, { projects: [], server: true, host: { name: 'box' } }))).not.toHaveProperty('host')
  })

  it('relinks and forgets with the same JSON POST as the open', async () => {
    const fetchFn = vi.fn(answer(200, { id: 'g1' }))
    expect(await openProject(fetchFn, { relink: 'g1', path: '/srv/moved' })).toEqual({ ok: true, id: 'g1' })
    expect(await openProject(fetchFn, { forget: 'g1' })).toEqual({ ok: true, id: 'g1' })
    expect(fetchFn.mock.calls.map((c) => (c as unknown as [string, { body: string }])[1].body)).toEqual(['{"relink":"g1","path":"/srv/moved"}', '{"forget":"g1"}'])
    expect(await openProject(answer(400, { error: 'the project folder is not missing' }), { forget: 'g1' })).toEqual({
      ok: false,
      signedOut: false,
      error: 'the project folder is not missing'
    })
  })
})

// Server mode's folder browser, the page's side (renderer/web/picker-model.ts, folder-browser.tsx).
describe('the folder browser', () => {
  const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const listing = {
    path: '/home/me/src',
    parent: '/home/me',
    home: '/home/me',
    folders: [{ name: 'app', git: true }, { name: 'docs', project: true, extra: 1 }, { name: 'link', link: true }] as WebFolderEntry[],
    hiddenCount: 2,
    truncated: false,
    here: { git: false, project: true }
  }

  it('asks with a JSON POST and checks every field of the answer', async () => {
    const fetchFn = vi.fn(answer(200, { ...listing, note: 'start folder gone' }))
    expect(await loadFolders(fetchFn, { path: '/home/me/src', hidden: true })).toEqual({
      ok: true,
      listing: {
        ...listing,
        folders: [{ name: 'app', git: true }, { name: 'docs', project: true }, { name: 'link', link: true }],
        note: 'start folder gone'
      }
    })
    expect(fetchFn).toHaveBeenCalledWith(FOLDERS_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{"path":"/home/me/src","hidden":true}'
    })
    // A name that is not one path segment is dropped (it is joined onto the path).
    const bad = { ...listing, folders: [{ name: '..' }, { name: 'a/b' }, { name: '' }, { name: 3 }, 'x', { name: 'ok' }] }
    expect(await loadFolders(answer(200, bad), {})).toMatchObject({ ok: true, listing: { folders: [{ name: 'ok' }] } })
    // More than the cap is cut to it.
    const many = { ...listing, folders: Array.from({ length: MAX_FOLDER_ENTRIES + 3 }, (_, i) => ({ name: `d${i}` })) }
    const capped = await loadFolders(answer(200, many), {})
    expect(capped.ok && capped.listing.folders.length).toBe(MAX_FOLDER_ENTRIES)
    expect(await loadFolders(answer(200, { ...listing, path: 'relative' }), {})).toMatchObject({ ok: false, signedOut: false })
  })

  it('an unreadable folder is a listing with its error; a refused request, signed out or no answer is not', async () => {
    expect(await loadFolders(answer(200, { path: '/root', parent: '/', home: '/home/me', error: 'permission denied' }), {})).toEqual({
      ok: true,
      listing: { path: '/root', parent: '/', home: '/home/me', folders: [], hiddenCount: 0, truncated: false, here: { git: false, project: false }, error: 'permission denied' }
    })
    expect(await loadFolders(answer(400, { error: 'not an absolute path: x' }), { path: 'x' })).toEqual({ ok: false, signedOut: false, error: 'not an absolute path: x' })
    expect(await loadFolders(answer(401, {}), {})).toEqual({ ok: false, signedOut: true })
    expect(await loadFolders(answer(404, 'not found'), {})).toEqual({ ok: false, signedOut: false, error: 'the host answered 404' })
    expect(
      await loadFolders(async () => {
        throw new TypeError('Failed to fetch')
      }, {})
    ).toEqual({ ok: false, signedOut: false, error: 'the host did not answer' })
  })

  it('breadcrumbs start at ~ under home, else at /', () => {
    expect(breadcrumbs('/home/me/src/app', '/home/me')).toEqual([
      { label: '~', path: '/home/me' },
      { label: 'src', path: '/home/me/src' },
      { label: 'app', path: '/home/me/src/app' }
    ])
    expect(breadcrumbs('/home/me', '/home/me/')).toEqual([{ label: '~', path: '/home/me' }])
    // `/home/meg` is not under `/home/me`.
    expect(breadcrumbs('/home/meg', '/home/me')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'meg', path: '/home/meg' }
    ])
    expect(breadcrumbs('/', '/home/me')).toEqual([{ label: '/', path: '/' }])
    // A home of `/` shortens nothing.
    expect(breadcrumbs('/srv', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' }
    ])
  })

  it('joins, filters, expands ~ and completes a typed path from a listing', () => {
    expect(childPath('/', 'srv')).toBe('/srv')
    expect(childPath('/srv', 'app')).toBe('/srv/app')
    expect(filterFolders(listing.folders, ' DO ')).toEqual([{ name: 'docs', project: true, extra: 1 }])
    expect(filterFolders(listing.folders, '')).toHaveLength(3)
    expect(expandHome('~', '/home/me')).toBe('/home/me')
    expect(expandHome('~/src', '/home/me/')).toBe('/home/me/src')
    expect(expandHome('~other/x', '/home/me')).toBe('~other/x')
    expect(completionTarget('/home/me/sr', '/home/me')).toEqual({ dir: '/home/me', prefix: 'sr' })
    expect(completionTarget('~/src/', '/home/me')).toEqual({ dir: '/home/me/src', prefix: '' })
    expect(completionTarget('/sr', '/home/me')).toEqual({ dir: '/', prefix: 'sr' })
    expect(completionTarget('src', '/home/me')).toBeUndefined()
    const folders = [{ name: 'App' }, { name: 'apps' }, { name: 'docs' }]
    expect(completions(folders, { dir: '/srv', prefix: 'ap' })).toEqual(['/srv/App', '/srv/apps'])
    expect(completions(folders, { dir: '/', prefix: '' }, 2)).toEqual(['/App', '/apps'])
    expect(commonPrefix(['/srv/app', '/srv/apps'])).toBe('/srv/app')
    expect(commonPrefix(['/srv/App', '/srv/apps'])).toBe('/srv/')
    expect(commonPrefix([])).toBe('')
  })
})

/** The chrome a page of this shell kind draws on this platform (navigator stubbed). */
function shellChrome(web: boolean, mac: boolean): ReturnType<typeof currentShellChrome> {
  resetShellKindForTest()
  vi.stubGlobal('navigator', { platform: mac ? 'MacIntel' : 'Linux x86_64' })
  if (web) markWebShell()
  return currentShellChrome()
}

describe('window chrome in the web shell', () => {
  afterEach(() => {
    resetShellKindForTest()
    vi.unstubAllGlobals()
  })

  it('the web shell draws no title bar, full screen, see-through or update notice, on any platform', () => {
    for (const mac of [true, false]) {
      expect(shellChrome(true, mac)).toEqual({ titleBar: false, fullScreen: false, seeThrough: false, updateNotice: false })
    }
    expect(shellChrome(false, true)).toEqual({ titleBar: true, fullScreen: true, seeThrough: true, updateNotice: true })
    expect(shellChrome(false, false)).toEqual({ titleBar: false, fullScreen: true, seeThrough: true, updateNotice: true })
  })

  it('markWebShell marks the page and the root element', () => {
    expect(isWebShell()).toBe(false)
    const root = { dataset: {} as Record<string, string | undefined> }
    markWebShell(root)
    expect(isWebShell()).toBe(true)
    expect(root.dataset['shell']).toBe('web')
    expect(currentShellChrome().titleBar).toBe(false)
    expect(currentShellChrome().updateNotice).toBe(false)
  })

  it('the top bar drawn with the web shell\'s chrome has no title bar (no drag region, no traffic-light room)', () => {
    for (const mac of [true, false]) {
      const chrome = shellChrome(true, mac)
      expect(topStripClass(chrome.titleBar, chrome.fullScreen)).toBe('top-strip')
    }
    expect(topStripClass(shellChrome(false, true).titleBar, false)).toBe('top-strip title-bar')
  })
})

describe('the take of the terminal size on load', () => {
  afterEach(() => resetShellKindForTest())

  it('the first ready of a page takes, once', () => {
    markWebShell()
    armLoadTake(1)
    expect(takeLoadTake()).toBe(true)
    expect(takeLoadTake()).toBe(false)
  })

  it("the web shell's `?tab=` is selected once; never in the Electron shell", () => {
    armLoadTab('t1')
    expect(takeLoadTab()).toBeUndefined()
    markWebShell()
    armLoadTab('t1')
    expect(takeLoadTab()).toBe('t1')
    expect(takeLoadTab()).toBeUndefined()
  })

  it('a reconnect ready does not take', () => {
    markWebShell()
    armLoadTake(2)
    expect(takeLoadTake()).toBe(false)
  })

  it('the desktop shell never takes', () => {
    armLoadTake(1)
    expect(takeLoadTake()).toBe(false)
  })
})

describe('the "This computer" chip', () => {
  const desktop = `Mozilla/5.0 Chrome/140 ${desktopAgentSuffix('1.2.3', 'mac')}`
  it('shows only in the web shell of a desktop remote window', () => {
    expect(showsThisComputerChip(true, desktop)).toBe(true)
    expect(showsThisComputerChip(true, 'Mozilla/5.0 Chrome/140')).toBe(false)
    expect(showsThisComputerChip(false, desktop)).toBe(false)
  })
})
