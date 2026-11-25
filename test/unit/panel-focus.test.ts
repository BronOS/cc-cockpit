import { describe, expect, it } from 'vitest'
import { PanelFocusAsks } from '../../src/renderer/tabs/panel-focus'

// Review S4: the panel body unmounts whenever the panel is hidden, collapsed or moved; a remounted body
// must not replay the last focus ask. The ask is consumed by its taker, and hiding drops a pending one.

describe('PanelFocusAsks', () => {
  it('an ask is taken once: a second take (a remounted body) gets nothing', () => {
    const asks = new PanelFocusAsks()
    asks.ask('p1')
    expect(asks.take('p1', ['p1'])).toEqual({ tabId: 'p1' })
    expect(asks.take('p1', ['p1'])).toBeUndefined()
  })

  it('a named ask waits for the selection to reach it', () => {
    const asks = new PanelFocusAsks()
    asks.ask('p2')
    expect(asks.take('p1', ['p1', 'p2'])).toBeUndefined()
    expect(asks.take('p2', ['p1', 'p2'])).toEqual({ tabId: 'p2' })
  })

  it('null asks for the shown tab, or the Shell button of an empty panel', () => {
    const asks = new PanelFocusAsks()
    asks.ask(null)
    expect(asks.take('p1', ['p1'])).toEqual({ tabId: 'p1' })
    asks.ask(null)
    expect(asks.take(null, [])).toEqual({ shell: true })
    // A panel still filling (tabs, no selection yet) waits.
    asks.ask(null)
    expect(asks.take(null, ['p1'])).toBeUndefined()
    expect(asks.take('p1', ['p1'])).toEqual({ tabId: 'p1' })
  })

  it('hiding the panel drops a pending ask; an ask for a tab that left is dropped', () => {
    const asks = new PanelFocusAsks()
    asks.ask('p2')
    asks.drop()
    expect(asks.take('p2', ['p2'])).toBeUndefined()
    asks.ask('gone')
    expect(asks.take('p1', ['p1'])).toBeUndefined()
    // Dropped, not waiting: a later tab with that id is not focused by the old ask.
    expect(asks.take('gone', ['gone'])).toBeUndefined()
  })
})
