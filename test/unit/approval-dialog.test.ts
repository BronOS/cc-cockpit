// ApprovalDialog (design-web.md §9.6): Allow never the default, Enter does nothing, no focus taken,
// Allow armed only after the dialog has been visible for about a second. The guards are DOM-free
// (approval-model.ts); the markup is rendered without a DOM (react-dom/server), as WebConfirmCard's.
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { allowClickCounts, APPROVAL_ARM_MS, ApprovalArm, approvalKey, type ArmTimers } from '../../src/renderer/notices/approval-model'
import { isServerView, markWebShell, resetShellKindForTest, setServerHint } from '../../src/renderer/shell-kind'

/** Timers driven by hand: `advance(ms)` fires what is due. */
function fakeTimers(): ArmTimers & { advance(ms: number): void; pending(): number } {
  let now = 0
  let next = 1
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn, ms) => {
      const id = next++
      due.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void due.delete(h as number),
    advance(ms) {
      now += ms
      for (const [id, t] of [...due]) {
        if (t.at <= now) {
          due.delete(id)
          t.fn()
        }
      }
    },
    pending: () => due.size
  }
}

afterEach(() => resetShellKindForTest())

describe('ApprovalArm', () => {
  it('arms only after the dialog has been visible for about a second', () => {
    const timers = fakeTimers()
    const seen: boolean[] = []
    const arm = new ApprovalArm((a) => seen.push(a), timers)
    expect(arm.armed).toBe(false)
    arm.visible(true)
    timers.advance(APPROVAL_ARM_MS - 1)
    expect(arm.armed).toBe(false)
    timers.advance(1)
    expect(arm.armed).toBe(true)
    expect(seen).toEqual([true])
    expect(APPROVAL_ARM_MS).toBeGreaterThanOrEqual(800)
  })

  it('a hidden page disarms it, and the second starts over when it is shown again', () => {
    const timers = fakeTimers()
    const arm = new ApprovalArm(() => {}, timers)
    arm.visible(false)
    timers.advance(5 * APPROVAL_ARM_MS)
    expect(arm.armed).toBe(false)
    arm.visible(true)
    timers.advance(APPROVAL_ARM_MS / 2)
    arm.visible(false)
    timers.advance(APPROVAL_ARM_MS)
    expect(arm.armed).toBe(false)
    arm.visible(true)
    timers.advance(APPROVAL_ARM_MS)
    expect(arm.armed).toBe(true)
    // Hidden after arming, then back: disarmed again until a fresh second has passed.
    arm.visible(false)
    expect(arm.armed).toBe(false)
    arm.visible(true)
    expect(arm.armed).toBe(false)
    timers.advance(APPROVAL_ARM_MS)
    expect(arm.armed).toBe(true)
  })

  it('dispose stops the timer: a dialog taken down never arms', () => {
    const timers = fakeTimers()
    const seen: boolean[] = []
    const arm = new ApprovalArm((a) => seen.push(a), timers)
    arm.visible(true)
    arm.dispose()
    expect(timers.pending()).toBe(0)
    arm.visible(true)
    timers.advance(APPROVAL_ARM_MS)
    expect(seen).toEqual([])
  })
})

describe('allowClickCounts', () => {
  it('a click counts only on an armed Allow pressed while armed', () => {
    expect(allowClickCounts(false, undefined)).toBe(false)
    expect(allowClickCounts(false, true)).toBe(false)
    // A press begun before arming and released after is a click on its way, not an answer.
    expect(allowClickCounts(true, false)).toBe(false)
    expect(allowClickCounts(true, true)).toBe(true)
    // No press seen (an assistive technology's click): armed is enough.
    expect(allowClickCounts(true, undefined)).toBe(true)
  })
})

describe('approvalKey', () => {
  it('Enter and Space never press a button; Escape denies; typing passes through to nothing', () => {
    expect(approvalKey('Enter')).toBe('block')
    expect(approvalKey(' ')).toBe('block')
    expect(approvalKey('Spacebar')).toBe('block')
    expect(approvalKey('Escape')).toBe('deny')
    expect(approvalKey('y')).toBe('pass')
    expect(approvalKey('Tab')).toBe('pass')
  })
})

describe('ApprovalBox markup', () => {
  type Props = { title: string; children: string; canAllow: boolean; note?: string; onAnswer(a: boolean): void; initiallyArmed?: boolean }
  async function render(props: Omit<Props, 'onAnswer' | 'title' | 'children'>): Promise<string> {
    // A .tsx module, loaded by a path the node typecheck does not follow (it has no JSX or DOM
    // lib); vitest transforms it like any other.
    const file = '../../src/renderer/notices/ApprovalDialog.tsx'
    const { ApprovalBox } = (await import(file)) as { ApprovalBox: FunctionComponent<Props> }
    return renderToStaticMarkup(createElement(ApprovalBox, { title: 'Link <b>x</b>?', children: 'Body', onAnswer: () => {}, ...props }))
  }

  it('no form, no default button, no autofocus; Allow starts disabled', async () => {
    const html = await render({ canAllow: true })
    expect(html).not.toContain('<form')
    expect(html.toLowerCase()).not.toContain('autofocus')
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b).toContain('type="button"')
    expect(html).toMatch(/<button type="button" class="confirm-danger" disabled="">Allow<\/button>/)
    // The title is plain text.
    expect(html).toContain('Link &lt;b&gt;x&lt;/b&gt;?')
    expect(html).toContain('role="alertdialog"')
  })

  it('armed, Allow is enabled; without canAllow the note stands in its place', async () => {
    expect(await render({ canAllow: true, initiallyArmed: true })).toMatch(/<button type="button" class="confirm-danger">Allow<\/button>/)
    const denied = await render({ canAllow: false, note: 'Approve on the desktop' })
    expect(denied).not.toContain('Allow</button>')
    expect(denied).toContain('Approve on the desktop')
  })
})

describe('isServerView', () => {
  it('true only in the web shell told by ready that the app is a server', () => {
    setServerHint(true)
    expect(isServerView()).toBe(false)
    markWebShell()
    expect(isServerView()).toBe(true)
    setServerHint(false)
    expect(isServerView()).toBe(false)
  })
})
