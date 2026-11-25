import { describe, expect, it } from 'vitest'
import { keepSelectedInView, type StripList } from '../../src/renderer/tabs/panel-strip-scroll'

// QR-N1: after a side zone was narrowed by its divider, the selected Terminal panel tab stayed scrolled
// out of the strip (only its icon showed): it was brought into view on selection only.
function strip(ids: string[]): { list: StripList; scrolls: string[] } {
  const scrolls: string[] = []
  const tabs = ids.map((id) => ({
    dataset: { panelTabId: id } as DOMStringMap,
    scrollIntoView: (arg?: ScrollIntoViewOptions) => {
      expect(arg).toEqual({ block: 'nearest', inline: 'nearest' })
      scrolls.push(id)
    },
  }))
  return { list: { querySelectorAll: () => tabs }, scrolls }
}

class FakeObserver {
  static last: FakeObserver | null = null
  observed = 0
  disconnected = false
  constructor(readonly cb: (entries: { contentRect: { width: number } }[]) => void) {
    FakeObserver.last = this
  }
  observe(): void {
    this.observed++
  }
  disconnect(): void {
    this.disconnected = true
  }
  width(w: number): void {
    this.cb([{ contentRect: { width: w } }])
  }
}

describe('keepSelectedInView', () => {
  it('scrolls the selected tab into view at once, and again when the strip narrows', () => {
    const { list, scrolls } = strip(['a', 'b', 'c'])
    keepSelectedInView(list, 'c', FakeObserver)
    expect(scrolls).toEqual(['c'])
    const obs = FakeObserver.last!
    expect(obs.observed).toBe(1)
    obs.width(320) // the observe's own first report: already scrolled for
    expect(scrolls).toEqual(['c'])
    obs.width(200) // the divider dragged narrower
    expect(scrolls).toEqual(['c', 'c'])
    obs.width(260)
    expect(scrolls).toEqual(['c', 'c', 'c'])
  })

  it('a report with the same width (a height change) does not scroll', () => {
    const { list, scrolls } = strip(['a', 'b'])
    keepSelectedInView(list, 'b', FakeObserver)
    const obs = FakeObserver.last!
    obs.width(300)
    obs.width(300)
    expect(scrolls).toEqual(['b'])
  })

  it('the cleanup stops watching', () => {
    const { list } = strip(['a'])
    const stop = keepSelectedInView(list, 'a', FakeObserver)
    stop()
    expect(FakeObserver.last!.disconnected).toBe(true)
  })

  it('a selected id not in the strip scrolls nothing', () => {
    const { list, scrolls } = strip(['a'])
    keepSelectedInView(list, 'gone', FakeObserver)
    FakeObserver.last!.width(100)
    FakeObserver.last!.width(90)
    expect(scrolls).toEqual([])
  })
})
