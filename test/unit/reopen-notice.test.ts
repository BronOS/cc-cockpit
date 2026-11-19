import { describe, expect, it } from 'vitest'
import { createReopenNotice, REOPEN_DETAIL, reopenBoxOptions, type ReopenNoticeDeps } from '../../src/main/reopen-notice'
import { serverBoxMessage } from '../../src/main/second-launch'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(over: Partial<ReopenNoticeDeps> = {}) {
  const calls: string[] = []
  const boxes: Array<{ options: unknown; answer: (n: number) => void; fail: (e: Error) => void }> = []
  const deps: ReopenNoticeDeps = {
    enabled: true,
    address: () => Promise.resolve('http://127.0.0.1:1'),
    testAnswer: undefined,
    focus: () => calls.push('focus'),
    showBox: (options) =>
      new Promise((resolve, reject) => {
        calls.push('box')
        boxes.push({ options, answer: resolve, fail: reject })
      }),
    accessory: () => calls.push('accessory'),
    quit: () => calls.push('quit'),
    log: (l) => calls.push(`log:${l}`),
    ...over
  }
  return { notice: createReopenNotice(deps), calls, boxes }
}

describe('reopen notice', () => {
  it('focuses, shows the shared text with Stop and Cancel, and the LaunchAgent detail', async () => {
    const { notice, calls, boxes } = setup()
    notice.onActivate()
    await tick()
    expect(calls).toEqual(['focus', 'box'])
    expect(boxes[0]?.options).toEqual(reopenBoxOptions('http://127.0.0.1:1'))
    expect(reopenBoxOptions('x')).toMatchObject({ message: serverBoxMessage('x'), detail: REOPEN_DETAIL, buttons: ['Stop', 'Cancel'] })
    expect(REOPEN_DETAIL).toContain('LaunchAgent starts it again at your next login')
  })

  it('shows one box at a time; a second activate re-applies the policy and shows nothing more', async () => {
    const { notice, calls, boxes } = setup()
    notice.onActivate()
    await tick()
    notice.onActivate()
    expect(calls).toEqual(['focus', 'box', 'accessory'])
    expect(boxes).toHaveLength(1)
    boxes[0]?.answer(1)
    await tick()
    notice.onActivate()
    await tick()
    expect(boxes).toHaveLength(2)
    expect(notice.count()).toBe(2)
  })

  it('Cancel does nothing but put the Dock icon away again', async () => {
    const { notice, calls, boxes } = setup()
    notice.onActivate()
    await tick()
    boxes[0]?.answer(1)
    await tick()
    expect(calls).toEqual(['focus', 'box', 'accessory'])
  })

  it('Stop re-applies the policy and quits', async () => {
    const { notice, calls, boxes } = setup()
    notice.onActivate()
    await tick()
    boxes[0]?.answer(0)
    await tick()
    expect(calls).toEqual(['focus', 'box', 'accessory', 'quit'])
  })

  it('a failing box counts as Cancel', async () => {
    const { notice, calls, boxes } = setup()
    notice.onActivate()
    await tick()
    boxes[0]?.fail(new Error('no'))
    await tick()
    expect(calls).toEqual(['focus', 'box', 'accessory'])
  })

  it('a test answer replaces the box', async () => {
    const stop = setup({ testAnswer: 'stop' })
    stop.notice.onActivate()
    await tick()
    expect(stop.calls).toEqual(['focus', 'accessory', 'quit'])
    const cancel = setup({ testAnswer: 'cancel' })
    cancel.notice.onActivate()
    await tick()
    expect(cancel.calls).toEqual(['focus', 'accessory'])
    expect(cancel.notice.count()).toBe(1)
  })

  it('does nothing when not enabled', async () => {
    const { notice, calls } = setup({ enabled: false })
    notice.onActivate()
    await tick()
    expect(calls).toEqual([])
    expect(notice.count()).toBe(0)
  })
})
