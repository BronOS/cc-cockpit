import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The room mark ("Deliver room messages automatically", design-rooms.md §2) is the person's alone, like the tab flag:
// it lets room messages into a tab the person typed in, so a plugin, hook or `ccc` path that could set it would make
// it worthless. Its one writer is TabManager.setRoomMark, reached only from the shell page's `tabs.roomMark` (the
// router's registerRoomStripHandlers, wired in index.ts). The held badge's click (`rooms.deliverHeld`) pastes into a
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

describe('the room mark and the badge are reached only from the shell page', () => {
  it('setRoomMark is defined in the tab manager and called only from the strip handlers in index.ts', () => {
    const found = sites(/\bsetRoomMark\s*\(/)
    expect(filesOf(found)).toEqual(['src/main/index.ts', 'src/main/tabs/tab-manager.ts'])
    const index = readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8')
    const start = index.indexOf('registerRoomStripHandlers(router, {')
    expect(start).toBeGreaterThan(0)
    const block = index.slice(start, index.indexOf('\n  })\n', start))
    // One call in index.ts, and it is inside the strip handlers' deps.
    expect(index.match(/\.setRoomMark\(/g)).toHaveLength(1)
    expect(block).toContain('tabs.setRoomMark(projectId, tabId, mark)')
  })

  it('deliverHeld is called only by the room service and the strip handlers', () => {
    const found = sites(/\.deliverHeld\s*\(/)
    expect(filesOf(found)).toEqual(['src/main/index.ts', 'src/main/ipc/router.ts', 'src/main/rooms/room-service.ts'])
    const index = readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8')
    const start = index.indexOf('registerRoomStripHandlers(router, {')
    const block = index.slice(start, index.indexOf('\n  })\n', start))
    expect(index.match(/\.deliverHeld\(/g)).toHaveLength(1)
    expect(block).toContain('rooms.deliverHeld(tabId)')
  })

  it('the channels are named only by the shared channel list, the router and the shell renderer', () => {
    const found = sites(/(['"`])(tabs\.roomMark|rooms\.deliverHeld)\1/)
    for (const file of filesOf(found)) {
      expect(['src/shared/ipc.ts', 'src/main/ipc/router.ts'].includes(file) || file.startsWith('src/renderer/'), file).toBe(true)
    }
    expect(filesOf(found)).toContain('src/main/ipc/router.ts')
  })

  it('no plugin, host, hook, socket or CLI code names the mark writer, the badge or their channels', () => {
    const dirs = ['src/main/plugins', 'src/host', 'src/main/socket', 'src/main/sessions', 'src/main/hooks', 'src/cli', 'src/sdk', 'plugins']
    const files = dirs.flatMap((d) => sources(join(ROOT, d))).filter((p) => !p.includes('node_modules'))
    expect(files.length).toBeGreaterThan(20)
    const forbidden = [/\bsetRoomMark\b/, /\bdeliverHeld\b/, /\bmarkChanged\b/, /(['"`])(tabs\.roomMark|rooms\.deliverHeld)\1/]
    const found = files.flatMap((p) =>
      codeLines(readFileSync(p, 'utf8'))
        .filter(({ text }) => forbidden.some((re) => re.test(text)))
        .map(({ line }) => `${relative(ROOT, p)}:${line}`)
    )
    expect(found).toEqual([])
  })
})
