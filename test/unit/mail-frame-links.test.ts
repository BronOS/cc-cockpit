import { describe, expect, it } from 'vitest'
import { EXTERNAL_OPEN_WINDOW_MS, MAX_EXTERNAL_OPENS_PER_WINDOW } from '../../src/main/plugins/host-api'
import { overlayMailFramePlugin, windowOpenHandler, type FrameLike, type OverlayPageCheck } from '../../src/main/windows/mail-frame-links'

const REVIEWER = 'cc-plugin://cockpit.reviewer/overlay/review.html'
const GMAIL = 'cc-plugin://bronos.gmail/panels/thread.html'
/** A panel page of a plugin that also has an overlay open: same scheme and host, never an overlay page. */
const PANEL = 'cc-plugin://bronos.gmail/panels/list.html'

/** A frame chain from the top: chain('app://shell', REVIEWER, 'about:srcdoc') gives the srcdoc frame. */
function chain(...urls: string[]): FrameLike {
  let frame: FrameLike | null = null
  for (const url of urls) frame = { url, parent: frame }
  return frame!
}
const SHELL = 'file:///app/out/renderer/index.html'
const mailFrame = (page = REVIEWER): FrameLike => chain(SHELL, page, 'about:srcdoc')

/** Main's record of this window's open overlay pages, as OverlayManager.isOverlayPage compares them. */
function overlayPages(...pages: string[]): OverlayPageCheck {
  return (url) => {
    const u = new URL(url)
    return pages.some((p) => {
      const o = new URL(p)
      return o.protocol === u.protocol && o.host === u.host && o.pathname === u.pathname
    })
  }
}
const OPEN = overlayPages(REVIEWER, GMAIL)

function setup(check: OverlayPageCheck | null = OPEN): { handle: ReturnType<typeof windowOpenHandler>; opened: string[]; logs: string[] } {
  const opened: string[] = []
  const logs: string[] = []
  const handle = windowOpenHandler({
    openExternal: (url) => void opened.push(url),
    ...(check ? { isOverlayPage: check } : {}),
    log: (m) => void logs.push(m)
  })
  return { handle, opened, logs }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('overlayMailFramePlugin', () => {
  it.each([
    ["the Reviewer overlay's mail frame", mailFrame(), 'cockpit.reviewer'],
    ["another plugin's overlay mail frame", mailFrame(GMAIL), 'bronos.gmail'],
    ['the overlay page with a query or hash', chain(SHELL, `${GMAIL}?x#y`, 'about:srcdoc'), 'bronos.gmail'],
    ['the overlay page itself', chain(SHELL, GMAIL), undefined],
    ['the shell page', chain(SHELL), undefined],
    ["a panel page's srcdoc child (same plugin, no overlay at that path)", chain(SHELL, PANEL, 'about:srcdoc'), undefined],
    ["a closed overlay's page", chain(SHELL, 'cc-plugin://bronos.jira/panels/issue.html', 'about:srcdoc'), undefined],
    ['an inline overlay with that path', chain(SHELL, 'cc-overlay://bronos.gmail/panels/thread.html', 'about:srcdoc'), undefined],
    ['a non-srcdoc child of the overlay page', chain(SHELL, GMAIL, 'about:blank'), undefined],
    ['a srcdoc frame nested one deeper', chain(SHELL, GMAIL, 'about:srcdoc', 'about:srcdoc'), undefined],
    ['the overlay page nested under another frame', chain(SHELL, 'cc-plugin://evil.one/p.html', GMAIL, 'about:srcdoc'), undefined],
    ['no focused frame', null, undefined]
  ])('%s', (_name, frame, expected) => {
    expect(overlayMailFramePlugin(frame, OPEN)).toBe(expected)
  })

  it("mail frame: a panel page's, the shell's or a deeper nested srcdoc never matches; each window has its own budget", async () => {
    // Even a check that says yes to everything: the frame's place decides first.
    const yes: OverlayPageCheck = () => true
    expect(overlayMailFramePlugin(chain(SHELL, 'about:srcdoc'), yes)).toBeUndefined()
    expect(overlayMailFramePlugin(chain(SHELL, GMAIL, 'about:srcdoc', 'about:srcdoc'), yes)).toBeUndefined()
    // A panel page: main's record has no overlay at its path.
    expect(overlayMailFramePlugin(chain(SHELL, PANEL, 'about:srcdoc'), OPEN)).toBeUndefined()
    // Two windows, two handlers: one spending its budget leaves the other's whole.
    const one = setup()
    const two = setup()
    for (let i = 0; i < MAX_EXTERNAL_OPENS_PER_WINDOW + 1; i++) one.handle({ url: `https://example.com/${i}` }, mailFrame(GMAIL))
    two.handle({ url: 'https://example.com/two' }, mailFrame(GMAIL))
    await settle()
    expect(one.opened).toHaveLength(MAX_EXTERNAL_OPENS_PER_WINDOW)
    expect(two.opened).toEqual(['https://example.com/two'])
  })

  it('fail closed: no check, a check that throws, an unreadable or unparsable parent URL is no match', () => {
    expect(overlayMailFramePlugin(mailFrame(GMAIL), undefined)).toBeUndefined()
    const throwing: OverlayPageCheck = () => {
      throw new Error('boom')
    }
    expect(overlayMailFramePlugin(mailFrame(GMAIL), throwing)).toBeUndefined()
    const shell: FrameLike = { url: SHELL, parent: null }
    const unreadable: FrameLike = { get url(): string { throw new Error('Render frame was disposed') }, parent: shell }
    expect(overlayMailFramePlugin({ url: 'about:srcdoc', parent: unreadable }, () => true)).toBeUndefined()
    expect(overlayMailFramePlugin(chain(SHELL, 'not a url', 'about:srcdoc'), () => true)).toBeUndefined()
    // A check that answers something other than true.
    expect(overlayMailFramePlugin(mailFrame(GMAIL), (() => 'yes') as unknown as OverlayPageCheck)).toBeUndefined()
  })

  it('is no match for a frame that throws when read (destroyed in Electron)', () => {
    const gone = { get url(): string { throw new Error('Render frame was disposed') }, parent: null }
    expect(overlayMailFramePlugin(gone, OPEN)).toBeUndefined()
  })
})

describe('windowOpenHandler', () => {
  it.each(['https://jira.example.com/browse/PROJ-7', 'http://example.com/a?b=c'])('denies the window and opens %s from a mail frame', async (url) => {
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
    ['an overlay page itself', chain(SHELL, REVIEWER)],
    ["a page that is no open overlay's", chain(SHELL, 'cc-plugin://evil.one/p.html')],
    ["a srcdoc frame of a page that is no open overlay's", chain(SHELL, 'cc-plugin://evil.one/p.html', 'about:srcdoc')],
    ["a panel page's srcdoc frame", chain(SHELL, PANEL, 'about:srcdoc')],
    ['no focused frame', null]
  ])('ignores a request from %s: denied as before, nothing opened, nothing logged', async (_name, frame) => {
    const { handle, opened, logs } = setup()
    expect(handle({ url: 'https://example.com/' }, frame)).toEqual({ action: 'deny' })
    await settle()
    expect(opened).toEqual([])
    expect(logs).toEqual([])
  })

  it('with no overlay check wired, even a mail frame opens nothing', async () => {
    const { handle, opened, logs } = setup(null)
    expect(handle({ url: 'https://example.com/' }, mailFrame())).toEqual({ action: 'deny' })
    await settle()
    expect(opened).toEqual([])
    expect(logs).toEqual([])
  })

  it("3 links in 10 s per plugin of a window, refused ones spend none; each plugin has its own budget", async () => {
    expect([MAX_EXTERNAL_OPENS_PER_WINDOW, EXTERNAL_OPEN_WINDOW_MS]).toEqual([3, 10_000])
    const { handle, opened, logs } = setup()
    handle({ url: 'file:///x' }, mailFrame())
    for (let i = 0; i < MAX_EXTERNAL_OPENS_PER_WINDOW + 2; i++) expect(handle({ url: `https://example.com/${i}` }, mailFrame())).toEqual({ action: 'deny' })
    // Another plugin's overlay in the same window: its own 3.
    handle({ url: 'https://example.com/gmail' }, mailFrame(GMAIL))
    await settle()
    expect(opened).toEqual(['https://example.com/0', 'https://example.com/1', 'https://example.com/2', 'https://example.com/gmail'])
    expect(logs.filter((l) => l.includes('more than 3 links in 10 s'))).toHaveLength(2)
  })

  it('a failing or throwing system open is logged, never thrown into Electron', async () => {
    const logs: string[] = []
    const rejecting = windowOpenHandler({ openExternal: () => Promise.reject(new Error('no browser')), isOverlayPage: OPEN, log: (m) => void logs.push(m) })
    const throwing = windowOpenHandler({
      openExternal: () => {
        throw new Error('boom')
      },
      isOverlayPage: OPEN,
      log: (m) => void logs.push(m)
    })
    expect(rejecting({ url: 'https://example.com/' }, mailFrame())).toEqual({ action: 'deny' })
    expect(throwing({ url: 'https://example.com/' }, mailFrame())).toEqual({ action: 'deny' })
    await settle()
    expect([...logs].sort()).toEqual(['mail link: open external failed: boom', 'mail link: open external failed: no browser'])
  })
})
