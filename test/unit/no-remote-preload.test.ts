import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Remote desktop windows (design-remote-desktop.md §7): the server's page is a browser page. Its
// window must never get the shell's bridge script (a compromised server would then reach local
// IPC), and the `persist:remote-` partitions (each holding a server's device cookie while the app
// runs) must never be handed to another window: only the remote window adapter names them.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')
const ADAPTER = ['src', 'main', 'remote', 'electron-remote-window.ts'].join(sep)

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : []
  })
}

/** Code lines only: a comment may name what it keeps out. */
function codeLines(text: string): Array<{ line: number; text: string }> {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
}

describe('remote windows: no bridge script, partitions nowhere else', () => {
  it('the adapter exists', () => {
    expect(sources(SRC).map((p) => relative(ROOT, p))).toContain(ADAPTER)
  })

  it('the adapter never sets a preload', () => {
    const text = readFileSync(join(ROOT, ADAPTER), 'utf8')
    const found = codeLines(text).filter(({ text: t }) => /preload/i.test(t)).map(({ line }) => `${ADAPTER}:${line}`)
    expect(found).toEqual([])
  })

  it('no other source file names a persist:remote- partition', () => {
    const found = sources(SRC)
      .filter((p) => relative(ROOT, p) !== ADAPTER)
      .filter((p) => readFileSync(p, 'utf8').includes('persist:remote-'))
      .map((p) => relative(ROOT, p))
    expect(found).toEqual([])
  })
})
