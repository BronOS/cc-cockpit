// A plugin close ask for a tab the strip does not show yet waits for it (close-ask-wait.ts): the
// plugin's open-then-close must close the tab, not fail because React had not committed the tab.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNLISTED_ASK_MS, UnlistedCloseAsks } from '../../src/renderer/tabs/close-ask-wait'

describe('UnlistedCloseAsks', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks once the tab reaches the strip, oldest first, and only the asks whose tab came', () => {
    const ran: string[] = []
    const asks = new UnlistedCloseAsks((requestId, tabId) => ran.push(`${requestId}:${tabId}`))
    asks.park('close-1', 't1')
    asks.park('close-2', 't2')
    asks.park('close-3', 't1')
    asks.tabsChanged(() => false)
    expect(ran).toEqual([])
    asks.tabsChanged((id) => id === 't1')
    expect(ran).toEqual(['close-1:t1', 'close-3:t1'])
    expect(asks.size).toBe(1)
    // Asked once: a later change does not ask again.
    asks.tabsChanged(() => true)
    expect(ran).toEqual(['close-1:t1', 'close-3:t1', 'close-2:t2'])
    asks.tabsChanged(() => true)
    expect(ran).toHaveLength(3)
    asks.clear()
  })

  it('hands an ask back once the wait runs out (the pane declines it), and a repeat id is one ask', () => {
    vi.useFakeTimers()
    const ran: string[] = []
    const asks = new UnlistedCloseAsks((requestId) => ran.push(requestId))
    asks.park('close-1', 'gone')
    asks.park('close-1', 'gone')
    vi.advanceTimersByTime(UNLISTED_ASK_MS - 1)
    expect(ran).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ran).toEqual(['close-1'])
    expect(asks.size).toBe(0)
    // The tab showing up after that asks nothing twice.
    asks.tabsChanged(() => true)
    expect(ran).toEqual(['close-1'])
  })

  it('clear drops every wait and runs nothing', () => {
    vi.useFakeTimers()
    const ran: string[] = []
    const asks = new UnlistedCloseAsks((requestId) => ran.push(requestId), 100)
    asks.park('close-1', 't1')
    asks.clear()
    vi.advanceTimersByTime(1000)
    asks.tabsChanged(() => true)
    expect(ran).toEqual([])
  })
})
