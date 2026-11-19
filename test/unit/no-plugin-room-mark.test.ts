import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The room mark ("Deliver room messages automatically", design-rooms.md §2) is the person's alone, like the tab flag:
// it lets room messages into a tab the person typed in, so a plugin, hook or `ccc` path that could set it would make
// it worthless. Its one writer after a join is TabManager.setRoomMark, reached only from the shell page's `tabs.roomMark` (the
// registerRoomStripHandlers in ipc/room-handlers.ts, wired in index.ts). A join (TabManager.setRoom, main's room service)
// gives a new membership the fixed initial value, on (design-rooms.md §2, a deliberate loosening): a constant, never
// an argument, so no plugin, hook or `ccc` input decides it. The held badge's click (`rooms.deliverHeld`) pastes into a
// typed tab as the person's act, so it gets the same rule. Checked on code lines (a comment may name them).

const ROOT = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : []
  })
}

function codeLines(text: string): Array<{ line: number; text: string }> {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
}

/** Every `file:line` under src/ (and the bundled plugins) whose code matches `re`. */
function sites(re: RegExp): string[] {
  const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'plugins'))].filter((p) => !p.includes('node_modules'))
  return files.flatMap((p) =>
    codeLines(readFileSync(p, 'utf8'))
      .filter(({ text }) => re.test(text))
      .map(({ line }) => `${relative(ROOT, p)}:${line}`)
  )
}

const filesOf = (found: string[]): string[] => [...new Set(found.map((s) => s.slice(0, s.lastIndexOf(':'))))].sort()

/** Code lines of index.ts, and the registerRoomStripHandlers call's lines (from its opening to its closing `})`). */
function indexParts(): { code: string[]; block: string[] } {
  const lines = codeLines(readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8'))
  const open = lines.findIndex(({ text }) => text.trim() === 'registerRoomStripHandlers(router, {')
  expect(open).toBeGreaterThan(0)
  const close = lines.findIndex(({ text }, i) => i > open && text === '  })')
  expect(close).toBeGreaterThan(open)
  return { code: lines.map((l) => l.text), block: lines.slice(open, close + 1).map((l) => l.text) }
}

const count = (lines: string[], re: RegExp): number => lines.reduce((n, l) => n + (l.match(new RegExp(re.source, 'g'))?.length ?? 0), 0)

describe('the room mark and the badge are reached only from the shell page', () => {
  // A bare-name match, not a call: `.bind(tabs)`, `const { setRoomMark } = tabs`, `tabs['setRoomMark']` and a call
  // all name it, so a second path cannot hide behind a spelling the receiving module never writes.
  const GUARDED = {
    setRoomMark: { re: /\bsetRoomMark\b/, files: ['src/main/index.ts', 'src/main/tabs/tab-manager.ts'] },
    deliverHeld: {
      re: /\bdeliverHeld\b/,
      // The renderer names the channel and its own handler; a page reaches main only over IPC (the channel test below).
      files: [
        'src/main/index.ts',
        'src/main/ipc/room-handlers.ts',
        'src/main/rooms/room-delivery.ts',
        'src/main/rooms/room-service.ts',
        'src/renderer/tabs/TabsPane.tsx',
        'src/shared/ipc.ts'
      ]
    },
    markTurnedOn: { re: /\bmarkTurnedOn\b/, files: ['src/main/index.ts', 'src/main/ipc/room-handlers.ts', 'src/main/rooms/room-service.ts'] }
  }

  for (const [name, { re, files }] of Object.entries(GUARDED)) {
    it(`${name} is named in code only by its own files`, () => {
      expect(filesOf(sites(re))).toEqual([...files].sort())
    })
  }

  it('in index.ts, each is named only inside the strip handlers, and the writer and the badge are called once', () => {
    const { code, block } = indexParts()
    for (const { re } of Object.values(GUARDED)) expect(count(code, re), re.source).toBe(count(block, re))
    expect(count(code, /\bsetRoomMark\b/)).toBe(1)
    expect(block.join('\n')).toContain('tabs.setRoomMark(projectId, tabId, mark)')
    // The deps key and the one call each.
    expect(count(code, /\bdeliverHeld\b/)).toBe(2)
    expect(count(code, /\brooms\.deliverHeld\(/)).toBe(1)
    expect(count(code, /\bmarkTurnedOn\b/)).toBe(2)
    expect(count(code, /\brooms\.markTurnedOn\(/)).toBe(1)
  })

  it('the channels are named only by the shared channel list, the room handlers and the shell renderer', () => {
    const found = sites(/(['"`])(tabs\.roomMark|rooms\.deliverHeld)\1/)
    for (const file of filesOf(found)) {
      expect(['src/shared/ipc.ts', 'src/main/ipc/room-handlers.ts'].includes(file) || file.startsWith('src/renderer/'), file).toBe(true)
    }
    expect(filesOf(found)).toContain('src/main/ipc/room-handlers.ts')
  })

  it('a join sets the initial mark from a constant, never from its arguments', () => {
    const lines = codeLines(readFileSync(join(ROOT, 'src', 'main', 'tabs', 'tab-manager.ts'), 'utf8')).map((l) => l.text)
    const open = lines.findIndex((t) => /^\s+setRoom\(projectId: string, tabId: string, room: \{ id: string; name: string; coordinator: boolean \}\): TabRoom \{$/.test(t))
    expect(open, 'setRoom signature (no mark in its room argument)').toBeGreaterThan(0)
    const close = lines.findIndex((t, i) => i > open && t === '  }')
    const body = lines.slice(open + 1, close).join('\n')
    // The one place the join names the mark: the literal, or the same membership keeping the person's own value.
    expect(body.match(/\bmark\b/g)).toHaveLength(3)
    expect(body).toContain('mark: true })')
    expect(body).toContain('next.mark = tab.room.mark')
    // The `room` argument's mark (a field a caller could smuggle in) is never read.
    expect(body.replaceAll('tab.room.mark', '')).not.toMatch(/\broom\.mark\b/)
  })

  it('no plugin, host, hook, socket or CLI code names the mark writer, the badge or their channels', () => {
    const dirs = ['src/main/plugins', 'src/host', 'src/main/socket', 'src/main/sessions', 'src/main/hooks', 'src/cli', 'src/sdk', 'plugins']
    const files = dirs.flatMap((d) => sources(join(ROOT, d))).filter((p) => !p.includes('node_modules'))
    expect(files.length).toBeGreaterThan(20)
    const forbidden = [/\bsetRoomMark\b/, /\bdeliverHeld\b/, /\bmarkTurnedOn\b/, /(['"`])(tabs\.roomMark|rooms\.deliverHeld)\1/]
    const found = files.flatMap((p) =>
      codeLines(readFileSync(p, 'utf8'))
        .filter(({ text }) => forbidden.some((re) => re.test(text)))
        .map(({ line }) => `${relative(ROOT, p)}:${line}`)
    )
    expect(found).toEqual([])
  })
})
