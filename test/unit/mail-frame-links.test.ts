import { describe, expect, it } from 'vitest'
import { EXTERNAL_OPEN_WINDOW_MS, MAX_EXTERNAL_OPENS_PER_WINDOW } from '../../src/main/plugins/host-api'
import { isReviewerMailFrame, windowOpenHandler, type FrameLike } from '../../src/main/windows/mail-frame-links'

const REVIEWER = 'cc-plugin://cockpit.reviewer/overlay/review.html'

/** A frame chain from the top: chain('app://shell', REVIEWER, 'about:srcdoc') gives the srcdoc frame. */
function chain(...urls: string[]): FrameLike {
  let frame: FrameLike | null = null
  for (const url of urls) frame = { url, parent: frame }
  return frame!
}
const SHELL = 'file:///app/out/renderer/index.html'
const mailFrame = (): FrameLike => chain(SHELL, REVIEWER, 'about:srcdoc')

function setup(): { handle: ReturnType<typeof windowOpenHandler>; opened: string[]; logs: string[] } {
  const opened: string[] = []
  const logs: string[] = []
  const handle = windowOpenHandler({ openExternal: (url) => void opened.push(url), log: (m) => void logs.push(m) })
  return { handle, opened, logs }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('isReviewerMailFrame', () => {
  it.each([
    ['the mail frame of the reviewer overlay', mailFrame(), true],
    ['the reviewer page with a query or hash', chain(SHELL, `${REVIEWER}?x#y`, 'about:srcdoc'), true],
    ['the reviewer page itself', chain(SHELL, REVIEWER), false],
    ['the shell page', chain(SHELL), false],
    ["another plugin's srcdoc frame", chain(SHELL, 'cc-plugin://evil.one/overlay/review.html', 'about:srcdoc'), false],
    ['a cockpit.* look-alike host', chain(SHELL, 'cc-plugin://cockpit.reviewer.evil/overlay/review.html', 'about:srcdoc'), false],
    ["another page of the reviewer's", chain(SHELL, 'cc-plugin://cockpit.reviewer/other.html', 'about:srcdoc'), false],
    ['an inline overlay with that path', chain(SHELL, 'cc-overlay://cockpit.reviewer/overlay/review.html', 'about:srcdoc'), false],
    ['a non-srcdoc child of the reviewer page', chain(SHELL, REVIEWER, 'about:blank'), false],
    ['a srcdoc frame nested one deeper', chain(SHELL, REVIEWER, 'about:srcdoc', 'about:srcdoc'), false],
    ['the reviewer page nested under another frame', chain(SHELL, 'cc-plugin://evil.one/p.html', REVIEWER, 'about:srcdoc'), false],
    ['no focused frame', null, false]
  ])('%s', (_name, frame, expected) => {
    expect(isReviewerMailFrame(frame)).toBe(expected)
  })

  it('is false for a frame that throws when read (destroyed in Electron)', () => {
    const gone = { get url(): string { throw new Error('Render frame was disposed') }, parent: null }
    expect(isReviewerMailFrame(gone)).toBe(false)
  })
})

describe('windowOpenHandler', () => {
  it.each(['https://jira.example.com/browse/PROJ-7', 'http://example.com/a?b=c'])('denies the window and opens %s from the mail frame', async (url) => {
    const { handle, opened } = setup()
    expect(handle({ url }, mailFrame())).toEqual({ action: 'deny' })
    await settle()
    expect(opened).toEqual([new URL(url).href])
  })

  it.each([
    ['javascript: (reaches main as about:blank)', 'about:blank'],
    ['javascript:', 'javascript:alert(1)'],
    ['file:', 'file:///etc/passwd'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a custom app scheme', 'vscode://file/etc/passwd'],
    ['ssh:', 'ssh://host'],
    ['mailto: (not opened, as from the Links list)', 'mailto:someone@example.com'],
    ['user:pass@', 'https://bank.example@evil.example/'],
    ['over the plugin URL limit', `https://example.com/${'a'.repeat(2100)}`],
    ['not a URL', 'not a url']
  ])('denies and opens nothing for %s', async (_name, url) => {
    const { handle, opened, logs } = setup()
    expect(handle({ url }, mailFrame())).toEqual({ action: 'deny' })
    await settle()
    expect(opened).toEqual([])
    expect(logs).toHaveLength(1)
  })

  it.each([
    ['the shell page', chain(SHELL)],
    ['the reviewer page itself', chain(SHELL, REVIEWER)],
    ["another plugin's page", chain(SHELL, 'cc-plugin://evil.one/p.html')],
    ["another plugin's srcdoc frame", chain(SHELL, 'cc-plugin://evil.one/p.html', 'about:srcdoc')],
    ['no focused frame', null]
  ])('ignores a request from %s: denied as before, nothing opened, nothing logged', async (_name, frame) => {
    const { handle, opened, logs } = setup()
    expect(handle({ url: 'https://example.com/' }, frame)).toEqual({ action: 'deny' })
    await settle()
    expect(opened).toEqual([])
    expect(logs).toEqual([])
  })

  it("keeps ctx.openExternal's budget: 3 links in 10 s, refused ones spend none", async () => {
    expect([MAX_EXTERNAL_OPENS_PER_WINDOW, EXTERNAL_OPEN_WINDOW_MS]).toEqual([3, 10_000])
    const { handle, opened, logs } = setup()
    handle({ url: 'file:///x' }, mailFrame())
    for (let i = 0; i < MAX_EXTERNAL_OPENS_PER_WINDOW + 2; i++) expect(handle({ url: `https://example.com/${i}` }, mailFrame())).toEqual({ action: 'deny' })
    await settle()
    expect(opened).toEqual(['https://example.com/0', 'https://example.com/1', 'https://example.com/2'])
    expect(logs.filter((l) => l.includes('more than 3 links in 10 s'))).toHaveLength(2)
  })

  it('a failing or throwing system open is logged, never thrown into Electron', async () => {
    const logs: string[] = []
    const rejecting = windowOpenHandler({ openExternal: () => Promise.reject(new Error('no browser')), log: (m) => void logs.push(m) })
    const throwing = windowOpenHandler({
      openExternal: () => {
        throw new Error('boom')
      },
      log: (m) => void logs.push(m)
    })
    expect(rejecting({ url: 'https://example.com/' }, mailFrame())).toEqual({ action: 'deny' })
    expect(throwing({ url: 'https://example.com/' }, mailFrame())).toEqual({ action: 'deny' })
    await settle()
    expect([...logs].sort()).toEqual(['mail link: open external failed: boom', 'mail link: open external failed: no browser'])
  })
})
