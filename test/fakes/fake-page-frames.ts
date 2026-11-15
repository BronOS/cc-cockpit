// A page tab frame pool with fake frame elements (renderer/tabs/page-frames.ts), for the frame,
// close and key tests: what each frame loaded, was posted, and what its page posts back.
import { PageFrames, type FrameRect, type PageFrameElement, type PageFramesOptions, type PageTabEntry } from '../../src/renderer/tabs/page-frames'
import { PORT_MESSAGE } from '../../src/sdk/panel-core'

export const TAB_A = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4a'
export const TAB_B = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4b'
export const TAB_C = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4c'
export const TAB_D = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4d'

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A frame element as the pool drives it: what it loaded, where it is placed (hidden: none), gone, focused, what was posted. */
export class FakeElement implements PageFrameElement {
  readonly loads: string[] = []
  readonly posts: Array<{ type: unknown; ports: number }> = []
  hidden = true
  removed = false
  focused = 0
  private listener: (() => void) | undefined
  constructor(readonly title: string) {}
  load(url: string): void {
    this.loads.push(url)
  }
  /** Where it was placed last (null: hidden), and how many placements it got. */
  box: FrameRect | null = null
  placed = 0
  place(box: FrameRect | null): void {
    this.box = box
    this.hidden = box === null
    this.placed++
  }
  post(message: unknown, transfer?: MessagePort[]): boolean {
    this.posts.push({ type: (message as { type?: unknown }).type, ports: transfer?.length ?? 0 })
    this.sent.push(message)
    return true
  }
  onLoad(listener: () => void): void {
    this.listener = listener
  }
  remove(): void {
    this.removed = true
  }
  focus(): void {
    this.focused++
  }
  /** What its page posts to the shell, and whether it has the keyboard (page-tab-close/keys tests). */
  readonly messageListeners: Array<(data: unknown) => void> = []
  focusedNow = false
  readonly sent: unknown[] = []
  onMessage(listener: (data: unknown) => void): void {
    this.messageListeners.push(listener)
  }
  hasFocus(): boolean {
    return this.focusedNow
  }
  /** Its page posts `data` to the shell. */
  fromPage(data: unknown): void {
    for (const l of this.messageListeners) l(data)
  }
  /** The page in it finished loading. */
  fire(): void {
    this.listener?.()
  }
  types(): unknown[] {
    return this.posts.map((p) => p.type)
  }
}

/** A box for `tab` in the layer, for `place` (any numbers: the pool only hands them on). */
export const boxOf = (tab: string, left = 0, width = 400): FrameRect & { tab: string } => ({ tab, left, top: 22, width, height: 300 })

export const entry = (id: string, plugin = 'a.one'): PageTabEntry => ({ id, plugin, type: 'file', title: `t-${id.slice(-1)}` })

export function pool(over: Partial<PageFramesOptions> = {}) {
  const elements: FakeElement[] = []
  const srcAsked: string[] = []
  const connects: Array<{ tabId: string; deliver: (port: MessagePort) => void; cancelled: boolean }> = []
  const disconnects: string[] = []
  const pages: Record<string, string | null> = {}
  const frames = new PageFrames({
    createFrame: (title) => {
      const el = new FakeElement(title)
      elements.push(el)
      return el
    },
    src: (tabId) => {
      srcAsked.push(tabId)
      return Promise.resolve(tabId in pages ? pages[tabId]! : `cc-plugin://a.one/tab.html`)
    },
    pageUrl: (src) => src,
    connect: (tabId, deliver) => {
      const c = { tabId, deliver, cancelled: false }
      connects.push(c)
      return () => {
        c.cancelled = true
      }
    },
    disconnect: (tabId) => void disconnects.push(tabId),
    guard: false,
    portMessage: { type: PORT_MESSAGE, remote: false },
    theme: () => ({ type: 'cc-plugin.theme' }),
    ...over
  })
  /** The latest element made for the tab whose title ends like `id`. */
  const el = (id: string): FakeElement => elements.filter((e) => e.title === `t-${id.slice(-1)}`).at(-1)!
  const port = (): MessagePort => new MessageChannel().port1
  return { frames, elements, srcAsked, connects, disconnects, pages, el, port }
}
