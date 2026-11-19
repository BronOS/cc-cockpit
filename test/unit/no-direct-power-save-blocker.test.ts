import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Keep awake (design.md §3): Electron's `powerSaveBlocker` is reached only through the power adapter,
// so the hold logic (src/main/power/power-holds.ts, keep-awake.ts) stays testable and no second owner
// can start or stop a blocker past PowerHolds, where one could stop another owner's (server mode's
// whole-run hold). Only the adapter may import or call it.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')
const ALLOWED = new Set(['src/main/power/electron-power.ts'].map((p) => p.split('/').join(sep)))

const FORBIDDEN = [
  // `powerSaveBlocker` in an import list from 'electron' (a multi-line list puts it on its own line).
  /^\s*powerSaveBlocker\s*,?\s*$/,
  /import\s*\{[^}]*\bpowerSaveBlocker\b[^}]*\}\s*from\s*['"]electron['"]/,
  // Used by name, through the `electron` namespace, or required.
  /(?<![\w.])powerSaveBlocker\s*\.\s*(start|stop|isStarted)\b/,
  /\belectron\s*\.\s*powerSaveBlocker\b/,
  /\bpowerSaveBlocker\b[^\n]*=\s*require\(\s*['"]electron['"]\s*\)/,
  /\{[^}]*\bpowerSaveBlocker\b[^}]*\}\s*=\s*(require\(\s*['"]electron['"]\s*\)|electron)\b/
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Code lines only: a comment may name the rule it follows. */
function offences(file: string, text: string): string[] {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
    .filter(({ text: t }) => FORBIDDEN.some((re) => re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

describe('no direct Electron powerSaveBlocker outside the power adapter', () => {
  it('finds none in src', () => {
    const found = sources(SRC).flatMap((p) => {
      const rel = relative(ROOT, p)
      return ALLOWED.has(rel) ? [] : offences(rel, readFileSync(p, 'utf8'))
    })
    expect(found).toEqual([])
  })

  it('every allowed file still exists and uses it', () => {
    for (const f of ALLOWED) expect(offences(f, readFileSync(join(ROOT, f), 'utf8')).length, f).toBeGreaterThan(0)
  })

  it('catches each form it forbids and ignores comments and other members', () => {
    const sample = [
      "import { app, powerSaveBlocker } from 'electron'",
      '  powerSaveBlocker,',
      "powerSaveBlocker.start('prevent-app-suspension')",
      'powerSaveBlocker.stop(id)',
      'electron.powerSaveBlocker',
      "const { powerSaveBlocker } = require('electron')",
      '// powerSaveBlocker.start is not allowed here',
      ' * powerSaveBlocker.stop in a doc comment',
      'powerHolds.hold(owner)',
      'this.powerSaveBlocker.start(x)'
    ].join('\n')
    expect(offences('x.ts', sample)).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:3', 'x.ts:4', 'x.ts:5', 'x.ts:6'])
  })
})
