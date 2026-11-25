import { describe, expect, it } from 'vitest'
import { panelTabParts } from '../../src/renderer/tabs/panel-tab-parts'

// QA Q1: in a narrow side zone the panel's strip showed "S.." and an exited command only "(exited)": the
// state text took the name's room. The state is a shape on the icon now; its words stay hidden for the
// accessible name, which keeps the main strip's form (`<label> (exited)`, test/e2e/SELECTORS.md).
describe('panelTabParts', () => {
  it('a running tab: its name, no mark, no hidden words', () => {
    expect(panelTabParts({ kind: 'shell' }, 'Shell')).toEqual({ icon: 'shell', state: null, name: 'Shell', stateText: '', title: 'Shell' })
  })

  it('an exited command: the whole name stays visible, the state is a mark and hidden words', () => {
    const p = panelTabParts({ kind: 'command', exit: { code: 1, signal: null } }, 'npm run dev')
    expect(p.name).toBe('npm run dev')
    expect(p.icon).toBe('command')
    expect(p.state).toBe('exited')
    expect(p.name + p.stateText).toBe('npm run dev (exited)')
    expect(p.title).toBe('npm run dev (exited)')
  })

  it('not started wins over an old exit (a restored tab not run yet)', () => {
    const p = panelTabParts({ kind: 'shell', notStarted: true, exit: { code: 0, signal: null } }, 'Shell')
    expect(p.state).toBe('notStarted')
    expect(p.stateText).toBe(' (not started)')
  })
})

// The strip's CSS: what keeps a name readable in a narrow zone (no DOM layout in unit tests, so the
// rules themselves are checked).
describe('the strip styles', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const css = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('a name keeps a minimum width and the strip scrolls past it', () => {
    expect(rule('.terminal-panel-tab-name')).toMatch(/min-width: 6ch/)
    // The tab and its label shrink only to their content's minimum (a label at 0 left "S..").
    expect(rule('.terminal-panel-tab')).toMatch(/min-width: auto/)
    expect(rule('.terminal-panel-tab-label')).toMatch(/min-width: auto/)
    expect(rule('.terminal-panel-tab-label')).not.toMatch(/min-width: 0/)
    expect(rule('.terminal-panel-tabs')).toMatch(/overflow-x: auto/)
  })

  it('the states are shapes on the icon, with no colour of their own', () => {
    expect(css).toMatch(/\.terminal-panel-tab-icon\[data-state='exited'\]::after/)
    expect(css).toMatch(/\.terminal-panel-tab-icon\[data-state='notStarted'\]::after/)
    expect(css).not.toMatch(/\.terminal-panel-tab-state/)
  })
})
