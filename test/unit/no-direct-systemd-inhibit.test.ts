import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Keep awake on Linux (design.md §3): the logind sleep lock is taken only by the power adapter
// (src/main/power/logind-inhibit.ts), one `systemd-inhibit` process per PowerHolds hold, so no second
// owner can take or end a lock past PowerHolds, where one could end another owner's, and every lock
// dies with main (its stdin pipe). Only that file may name the program in code.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')
const ALLOWED = new Set(['src/main/power/logind-inhibit.ts'].map((p) => p.split('/').join(sep)))

const FORBIDDEN = [/systemd-inhibit/, /\binhibit\b[^\n]*['"`]--what=/]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : []
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

describe('no systemd-inhibit outside the logind power adapter', () => {
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

  it('catches each form it forbids and ignores comments', () => {
    const sample = [
      "spawn('systemd-inhibit', ['--what=sleep', 'cat'])",
      "execFile('/usr/bin/systemd-inhibit', args)",
      "const inhibit = ['--what=idle']",
      '// systemd-inhibit is only in logind-inhibit.ts',
      ' * systemd-inhibit in a doc comment',
      'powerHolds.hold(owner)'
    ].join('\n')
    expect(offences('x.ts', sample)).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:3'])
  })
})
