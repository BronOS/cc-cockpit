// ApprovalDialog (design-web.md §9.6): Allow never the default, Enter does nothing, no focus taken,
// Allow armed only after the dialog has been visible for about a second. The guards are DOM-free
// (approval-model.ts); the markup is rendered without a DOM (react-dom/server), as WebConfirmCard's.
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { allowClickCounts, APPROVAL_ARM_MS, ApprovalArm, approvalKey, ApprovalStack, type ArmTimers } from '../../src/renderer/notices/approval-model'
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

  it('the same state again changes nothing: focus moving from a frame of the page to the page keeps it armed', () => {
    const timers = fakeTimers()
    const seen: boolean[] = []
    const arm = new ApprovalArm((a) => seen.push(a), timers)
    arm.visible(true)
    timers.advance(APPROVAL_ARM_MS / 2)
    // A second `true` does not restart the second either.
    arm.visible(true)
    timers.advance(APPROVAL_ARM_MS / 2)
    expect(arm.armed).toBe(true)
    arm.visible(true)
    expect(arm.armed).toBe(true)
    expect(seen).toEqual([true])
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

describe('ApprovalStack', () => {
  /** A dialog as ApprovalDialog wires it: armed when the page is seen and it is the top one. */
  function dialog(stack: ApprovalStack, timers: ArmTimers): { arm: ApprovalArm; leave: () => void } {
    const arm = new ApprovalArm(() => {}, timers)
    let top = false
    const leave = stack.enter((t) => {
      top = t
      arm.visible(top)
    })
    arm.visible(top)
    return { arm, leave }
  }

  it('a dialog covered by another never arms, and its second starts only when the upper one goes', () => {
    const timers = fakeTimers()
    const stack = new ApprovalStack()
    const link = dialog(stack, timers)
    timers.advance(APPROVAL_ARM_MS / 2)
    // A trash ask comes up over the link ask.
    const trash = dialog(stack, timers)
    timers.advance(5 * APPROVAL_ARM_MS)
    expect(trash.arm.armed).toBe(true)
    expect(link.arm.armed).toBe(false)
    // The trash ask is answered: the link ask is bared disarmed and needs its own second.
    trash.leave()
    expect(link.arm.armed).toBe(false)
    timers.advance(APPROVAL_ARM_MS - 1)
    expect(link.arm.armed).toBe(false)
    timers.advance(1)
    expect(link.arm.armed).toBe(true)
    link.leave()
    expect(stack.size).toBe(0)
  })

  it('an armed top dialog disarms when another opens over it; a covered one leaving changes nothing on top', () => {
    const timers = fakeTimers()
    const stack = new ApprovalStack()
    const first = dialog(stack, timers)
    timers.advance(APPROVAL_ARM_MS)
    expect(first.arm.armed).toBe(true)
    const second = dialog(stack, timers)
    expect(first.arm.armed).toBe(false)
    timers.advance(APPROVAL_ARM_MS)
    expect(second.arm.armed).toBe(true)
    // The covered one is settled elsewhere: the top one stays armed.
    first.leave()
    first.leave()
    expect(second.arm.armed).toBe(true)
    expect(stack.size).toBe(1)
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
  type Props = { title: string; children: string; onAnswer(a: boolean): void }
  async function render(): Promise<string> {
    // A .tsx module, loaded by a path the node typecheck does not follow (it has no JSX or DOM
    // lib); vitest transforms it like any other.
    const file = '../../src/renderer/notices/ApprovalDialog.tsx'
    const { ApprovalBox } = (await import(file)) as { ApprovalBox: FunctionComponent<Props> }
    return renderToStaticMarkup(createElement(ApprovalBox, { title: 'Link <b>x</b>?', children: 'Body', onAnswer: () => {} }))
  }

  it('no form, no default button, no autofocus; Allow starts disabled', async () => {
    const html = await render()
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
})

// plan Task 16: the Move to Trash confirm uses the same dialog; the file name and the plugin id are
// plain text, never markup.
describe('trash confirm markup', () => {
  type Ask = { requestId: string; path: string; kind: 'file' | 'folder'; pluginId: string }
  async function parts(): Promise<{ Title: FunctionComponent<{ ask: Ask }>; Text: FunctionComponent<{ ask: Ask }>; Box: FunctionComponent<Record<string, unknown>> }> {
    const notices = '../../src/renderer/notices/ShellNotices.tsx'
    const dialog = '../../src/renderer/notices/ApprovalDialog.tsx'
    const n = (await import(notices)) as { TrashAskTitle: FunctionComponent<{ ask: Ask }>; TrashAskText: FunctionComponent<{ ask: Ask }> }
    const d = (await import(dialog)) as { ApprovalBox: FunctionComponent<Record<string, unknown>> }
    return { Title: n.TrashAskTitle, Text: n.TrashAskText, Box: d.ApprovalBox }
  }

  it('shows the path and the plugin as plain text, with Cancel and a guarded Move to Trash', async () => {
    const { Title, Text, Box } = await parts()
    const ask: Ask = { requestId: 'trash-1', path: '<img src=x onerror=alert(1)>.txt', kind: 'folder', pluginId: 'cockpit.files' }
    const html = renderToStaticMarkup(
      createElement(Box, {
        title: createElement(Title, { ask }),
        children: createElement(Text, { ask }),
        allowLabel: 'Move to Trash',
        denyLabel: 'Cancel',
        onAnswer: () => {}
      })
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.txt')
    expect(html).toContain('Move the folder')
    expect(html).toContain('with everything in it')
    expect(html).toContain('cockpit.files')
    expect(html).toMatch(/<button type="button">Cancel<\/button>/)
    expect(html).toMatch(/<button type="button" class="confirm-danger" disabled="">Move to Trash<\/button>/)
  })
})

// plan Task 18: Close project in a server's browser shell asks with the same dialog; the project's
// name is plain text, and the button is drawn only in a server's browser view.
describe('close project', () => {
  type Box = FunctionComponent<Record<string, unknown>>
  async function parts(): Promise<{ Title: FunctionComponent<{ name: string }>; Box: Box; TopStrip: Box }> {
    const close = '../../src/renderer/web/CloseProject.tsx'
    const dialog = '../../src/renderer/notices/ApprovalDialog.tsx'
    const strip = '../../src/renderer/status/TopStrip.tsx'
    const c = (await import(close)) as { CloseProjectTitle: FunctionComponent<{ name: string }> }
    const d = (await import(dialog)) as { ApprovalBox: Box }
    const t = (await import(strip)) as { TopStrip: Box }
    return { Title: c.CloseProjectTitle, Box: d.ApprovalBox, TopStrip: t.TopStrip }
  }

  it('asks "Close <name> for every device? Its tabs end." with Cancel and a guarded Close project', async () => {
    const { Title, Box } = await parts()
    const html = renderToStaticMarkup(
      createElement(Box, {
        title: createElement(Title, { name: '<img src=x onerror=alert(1)>' }),
        children: 'Its tabs end.',
        allowLabel: 'Close project',
        denyLabel: 'Cancel',
        onAnswer: () => {}
      })
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('Close &lt;img src=x onerror=alert(1)&gt; for every device?')
    expect(html).toContain('Its tabs end.')
    expect(html).toMatch(/<button type="button">Cancel<\/button>/)
    expect(html).toMatch(/<button type="button" class="confirm-danger" disabled="">Close project<\/button>/)
  })

  it('the top bar draws Close project only in a server\'s browser view', async () => {
    const { TopStrip } = await parts()
    const project = { id: 'p1', name: 'alpha', path: '/srv/alpha', missing: false }
    const render = (): string => renderToStaticMarkup(createElement(TopStrip, { project, onOpenProject: () => {}, onOpenSettings: () => {} }))
    // The desktop window, a desktop's browser view, then a server's browser view.
    expect(render()).not.toContain('aria-label="Close project"')
    markWebShell()
    expect(render()).not.toContain('aria-label="Close project"')
    setServerHint(true)
    expect(render()).toContain('aria-label="Close project"')
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
