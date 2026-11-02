// Plan B Task 7: what `cc-preview://<token>/<path>` serves (webview panels' local files). Real
// files in a temp dir, the token table as a plain map; nothing touches the real home folder.
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREVIEW_CSP,
  PreviewBudget,
  PreviewBudgets,
  MAX_PREVIEW_FILE_BYTES,
  previewCharge,
  previewRootProblem,
  resolvePreviewFile,
  servePreviewRequest,
  type PreviewDeps
} from '../../src/main/webview/preview-protocol'

// open wrapped so a test can change the folder between the checks and the read (the swap a read
// by name would follow); everything else is the real module.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open) }
})

/** Run `swap` right before the next open (after every check of the request), then open for real. */
async function swapBeforeRead(swap: () => void): Promise<void> {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof real.open>) => {
    swap()
    return real.open(...args)
  })
}

const TOKEN = `t${'a'.repeat(32)}`
const OTHER = `t${'b'.repeat(32)}`

let root: string
let site: string
let outside: string
let deps: PreviewDeps

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-preview-')))
  site = join(root, 'site')
  outside = join(root, 'outside')
  for (const d of [site, join(site, 'css'), join(site, '.git'), outside]) mkdirSync(d, { recursive: true })
  writeFileSync(join(site, 'index.html'), '<link rel="stylesheet" href="css/app.css"><p>mock</p>')
  writeFileSync(join(site, 'css', 'app.css'), 'p { color: red }')
  writeFileSync(join(site, 'my page.html'), '<p>space</p>')
  writeFileSync(join(site, '.env'), 'SECRET=1')
  writeFileSync(join(site, '.git', 'config'), '[core]')
  writeFileSync(join(site, 'big.bin'), 'x'.repeat(2048))
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(join(outside, 'secret.txt'), join(site, 'escape.txt'))
  symlinkSync(outside, join(site, 'outdir'))
  symlinkSync(join(site, '.env'), join(site, 'env-alias.txt'))
  // A symlink that stays inside the folder but leads into a dot-folder.
  symlinkSync(join(site, '.git'), join(site, 'gitlink'))
  deps = { folderOf: (t) => (t === TOKEN ? site : undefined), maxBytes: 1024, log: () => {} }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const url = (path: string, token = TOKEN): string => `cc-preview://${token}${path}`

describe('resolvePreviewFile', () => {
  it('serves a file and the files next to it', async () => {
    expect(await resolvePreviewFile(url('/index.html'), deps)).toMatchObject({ ok: true, file: join(site, 'index.html') })
    expect(await resolvePreviewFile(url('/css/app.css'), deps)).toMatchObject({ ok: true, file: join(site, 'css', 'app.css') })
    expect(await resolvePreviewFile(url('/my%20page.html'), deps)).toMatchObject({ ok: true })
  })

  it.each([
    // The URL parser folds a literal `..`, and a `%2e%2e` segment too (the URL spec reads it as
    // `..`), to `/outside/secret.txt`, which is not in the folder.
    ['/../outside/secret.txt', 'no such file'],
    ['/%2e%2e/outside/secret.txt', 'no such file'],
    // Not a whole segment: left as is by the parser, refused by the escape check.
    ['/x%2e%2e/outside/secret.txt', 'encoded separator or dot'],
    ['/css%2f..%2f..%2foutside%2fsecret.txt', 'encoded separator or dot'],
    ['/a%5cb', 'encoded separator or dot'],
    ['/a%00b', 'encoded separator or dot']
  ])('refuses the traversal %s (%s)', async (path, reason) => {
    expect(await resolvePreviewFile(url(path), deps)).toEqual({ ok: false, reason })
  })

  it('refuses symlinks that lead out of the folder, and an alias of a dot-file', async () => {
    expect(await resolvePreviewFile(url('/escape.txt'), deps)).toEqual({ ok: false, reason: 'outside the folder' })
    expect(await resolvePreviewFile(url('/outdir/secret.txt'), deps)).toEqual({ ok: false, reason: 'outside the folder' })
    expect(await resolvePreviewFile(url('/env-alias.txt'), deps)).toEqual({ ok: false, reason: 'dot-file' })
    expect(await resolvePreviewFile(url('/gitlink/config'), deps)).toEqual({ ok: false, reason: 'dot-file' })
  })

  it('refuses everything under a root with a dot-folder on its path (a token never maps to one)', async () => {
    const dotRoot = { ...deps, folderOf: (t: string) => (t === TOKEN ? join(site, '.git') : undefined) }
    expect(await resolvePreviewFile(url('/config'), dotRoot)).toEqual({ ok: false, reason: 'dot-folder' })
  })

  it('refuses dot-files and dot-folders', async () => {
    expect(await resolvePreviewFile(url('/.env'), deps)).toEqual({ ok: false, reason: 'dot-file' })
    expect(await resolvePreviewFile(url('/.git/config'), deps)).toEqual({ ok: false, reason: 'dot-file' })
  })

  it('refuses an unknown or malformed token, another scheme, a folder and a missing file', async () => {
    expect(await resolvePreviewFile(url('/index.html', OTHER), deps)).toEqual({ ok: false, reason: 'unknown or revoked token' })
    expect(await resolvePreviewFile('cc-preview://nottoken/index.html', deps)).toEqual({ ok: false, reason: 'not a token' })
    expect(await resolvePreviewFile(`cc-plugin://${TOKEN}/index.html`, deps)).toEqual({ ok: false, reason: 'another scheme' })
    expect(await resolvePreviewFile(url('/'), deps)).toEqual({ ok: false, reason: 'no file named' })
    expect(await resolvePreviewFile(url('/css'), deps)).toEqual({ ok: false, reason: 'not a regular file' })
    expect(await resolvePreviewFile(url('/nope.html'), deps)).toEqual({ ok: false, reason: 'no such file' })
  })

  it('refuses a file over the size cap', async () => {
    expect(await resolvePreviewFile(url('/big.bin'), deps)).toEqual({ ok: false, reason: 'file too large' })
  })

  it('refuses a folder swapped for a symlink since the token was made', async () => {
    rmSync(site, { recursive: true, force: true })
    symlinkSync(outside, site)
    expect(await resolvePreviewFile(url('/secret.txt'), deps)).toEqual({ ok: false, reason: 'the folder moved' })
  })
})

describe('servePreviewRequest', () => {
  const expectHeaders = (res: Response): void => {
    expect(res.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  }

  it('answers with the file, its content type and the headers', async () => {
    const html = await servePreviewRequest(url('/index.html'), 'GET', deps)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await html.text()).toContain('<p>mock</p>')
    expectHeaders(html)
    const css = await servePreviewRequest(url('/css/app.css'), 'GET', deps)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expectHeaders(css)
  })

  it('carries the CSP and referrer policy on every response, 404s and refused methods included', async () => {
    for (const [u, method] of [
      [url('/.env'), 'GET'],
      [url('/escape.txt'), 'GET'],
      [url('/index.html', OTHER), 'GET'],
      [url('/index.html'), 'POST'],
      ['not a url', 'GET']
    ] as const) {
      const res = await servePreviewRequest(u, method, deps)
      expect(res.status, `${method} ${u}`).toBe(404)
      expectHeaders(res)
    }
    const head = await servePreviewRequest(url('/index.html'), 'HEAD', deps)
    expect(head.status).toBe(200)
    expectHeaders(head)
  })

  it('refuses a HEAD over the size cap like a GET', async () => {
    const head = await servePreviewRequest(url('/big.bin'), 'HEAD', deps)
    expect(head.status).toBe(404)
    expectHeaders(head)
  })

  it('refuses a file that grew past the cap between the stat and the read', async () => {
    const seen: string[] = []
    await swapBeforeRead(() => appendFileSync(join(site, 'index.html'), 'x'.repeat(2048)))
    const res = await servePreviewRequest(url('/index.html'), 'GET', { ...deps, log: (m) => seen.push(m) })
    expect(res.status).toBe(404)
    expectHeaders(res)
    // The checks passed: the refusal is the read-time one.
    expect(seen).toEqual(['cc-preview: 404: the file is too large'])
  })

  // The review finding: the checks passed, then the name was read again and followed a symlink
  // swapped in meanwhile, serving a file outside the folder.
  it('does not serve outside the folder when the file becomes a symlink between the checks and the read', async () => {
    const seen: string[] = []
    await swapBeforeRead(() => {
      rmSync(join(site, 'index.html'))
      symlinkSync(join(outside, 'secret.txt'), join(site, 'index.html'))
    })
    const res = await servePreviewRequest(url('/index.html'), 'GET', { ...deps, log: (m) => seen.push(m) })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret')
    expect(seen).toEqual(['cc-preview: 404: the file became a symlink while it was read'])
  })

  it('does not serve outside the folder when a folder above the file becomes a symlink between the checks and the read', async () => {
    writeFileSync(join(outside, 'app.css'), 'secret')
    const seen: string[] = []
    await swapBeforeRead(() => {
      renameSync(join(site, 'css'), join(root, 'old-css'))
      symlinkSync(outside, join(site, 'css'))
    })
    const res = await servePreviewRequest(url('/css/app.css'), 'GET', { ...deps, log: (m) => seen.push(m) })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret')
    expect(seen).toEqual(['cc-preview: 404: the file changed while it was read'])
  })

  // Review finding (ext round 9): every body was a whole Buffer in main with no limit, so a page
  // looping fetch() without reading the bodies could grow main's memory without bound.
  it('holds a session to its budget of unread bodies: past it a 503, room again once a body is read or dropped', async () => {
    // Room for two reads of index.html (its size plus the one byte of growth the read allows).
    const charge = statSync(join(site, 'index.html')).size + 1
    const budget = new PreviewBudget(2 * charge)
    const seen: string[] = []
    const withBudget: PreviewDeps = { ...deps, budget, log: (m) => seen.push(m) }
    const first = await servePreviewRequest(url('/index.html'), 'GET', withBudget)
    const second = await servePreviewRequest(url('/index.html'), 'GET', withBudget)
    expect([first.status, second.status]).toEqual([200, 200])
    expect(budget.inFlight).toBe(2 * charge)
    const third = await servePreviewRequest(url('/index.html'), 'GET', withBudget)
    expect(third.status).toBe(503)
    expectHeaders(third)
    expect(seen).toEqual(['cc-preview: 503: the session holds too many unread bodies'])
    // Read to the end: its bytes go back.
    expect(await first.text()).toContain('<p>mock</p>')
    expect(budget.inFlight).toBe(charge)
    // Dropped unread (the page aborted it, the view closed): back too.
    await second.body?.cancel()
    expect(budget.inFlight).toBe(0)
    expect((await servePreviewRequest(url('/index.html'), 'GET', withBudget)).status).toBe(200)
  })

  // Review finding (ext round 10): the cap was 2 x the largest file, but each request is charged
  // one byte over its size, so the second largest file got a 503.
  it('the default budget holds two of the largest files at their full charge, not a byte more', () => {
    const budget = new PreviewBudget()
    expect(budget.take(previewCharge(MAX_PREVIEW_FILE_BYTES))).toBe(true)
    expect(budget.take(previewCharge(MAX_PREVIEW_FILE_BYTES))).toBe(true)
    expect(budget.take(1)).toBe(false)
    expect(previewCharge(MAX_PREVIEW_FILE_BYTES * 2)).toBe(MAX_PREVIEW_FILE_BYTES + 1)
  })

  it('PreviewBudgets keeps one budget per partition and starts it over once dropped', () => {
    const budgets = new PreviewBudgets(10)
    const a = budgets.of('webview-P1-a.one')
    expect(budgets.of('webview-P1-a.one')).toBe(a)
    expect(budgets.of('webview-P1-a.two')).not.toBe(a)
    expect(a.take(10)).toBe(true)
    budgets.drop('webview-P1-a.one')
    const fresh = budgets.of('webview-P1-a.one')
    expect(fresh).not.toBe(a)
    expect(fresh.take(10)).toBe(true)
    // A body of the old views giving back goes to the forgotten budget only.
    a.release(10)
    expect(fresh.inFlight).toBe(10)
    expect(budgets.size).toBe(2)
  })

  it('gives the budget back at once for a HEAD, a 404 and a refused read', async () => {
    const budget = new PreviewBudget()
    const withBudget: PreviewDeps = { ...deps, budget }
    expect((await servePreviewRequest(url('/index.html'), 'HEAD', withBudget)).status).toBe(200)
    expect((await servePreviewRequest(url('/.env'), 'GET', withBudget)).status).toBe(404)
    await swapBeforeRead(() => appendFileSync(join(site, 'index.html'), 'x'.repeat(2048)))
    expect((await servePreviewRequest(url('/index.html'), 'GET', withBudget)).status).toBe(404)
    expect(budget.inFlight).toBe(0)
  })

  it('streams a body of several chunks whole', async () => {
    const data = Buffer.alloc(2.5 * 1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    writeFileSync(join(site, 'large.bin'), data)
    const budget = new PreviewBudget()
    const res = await servePreviewRequest(url('/large.bin'), 'GET', { ...deps, maxBytes: undefined, budget })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true)
    expect(budget.inFlight).toBe(0)
  })

  it('keeps the page off the network: its own token only, no form posts or frames elsewhere', () => {
    expect(PREVIEW_CSP).toContain("default-src 'self' 'unsafe-inline' data: blob:")
    expect(PREVIEW_CSP).toContain("form-action 'self'")
    expect(PREVIEW_CSP).not.toMatch(/https?:/)
    expect(PREVIEW_CSP).not.toMatch(/connect-src|img-src|frame-src/)
  })
})

describe('previewRootProblem', () => {
  const home = '/Users/me'
  it('refuses the root, the home folder and its ancestors', () => {
    expect(previewRootProblem('/', home)).toMatch(/file-system root/)
    expect(previewRootProblem(home, home)).toMatch(/home folder/)
    expect(previewRootProblem('/Users', home)).toMatch(/home folder/)
  })

  it('refuses the macOS data volume spelling of any folder (realpath keeps a firmlink as spelled)', () => {
    expect(previewRootProblem('/System/Volumes/Data', home)).toMatch(/System\/Volumes\/Data/)
    expect(previewRootProblem('/System/Volumes/Data/Users/me', home)).toMatch(/System\/Volumes\/Data/)
    expect(previewRootProblem('/System/Volumes/Data/Users/me/.ssh', home)).toMatch(/System\/Volumes\/Data/)
    expect(previewRootProblem('/System/Volumes/DataX/proj', home)).toBeNull()
  })

  it('refuses a folder with a dot-folder anywhere on its path, under home or not', () => {
    expect(previewRootProblem('/Users/me/proj/.git', home)).toMatch(/inside a dot-folder/)
    expect(previewRootProblem('/Users/me/proj/.secrets/pages', home)).toMatch(/inside a dot-folder/)
    expect(previewRootProblem('/opt/.x/y', home)).toMatch(/inside a dot-folder/)
    expect(previewRootProblem('/Users/me/proj/..cache', home)).toMatch(/inside a dot-folder/)
    expect(previewRootProblem('/Users/me/my.proj/v1.2', home)).toBeNull()
  })

  it('accepts a folder below home or elsewhere', () => {
    expect(previewRootProblem('/Users/me/proj', home)).toBeNull()
    expect(previewRootProblem('/Users/meme', home)).toBeNull()
    expect(previewRootProblem(dirname('/tmp/x/page.html'), home)).toBeNull()
  })
})
