import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// A page's renderer pid is read, and the renderer killed, only in renderer-kill.ts (the hung-page
// watchdog's adapter, hung-navigation.ts): there the pid is checked to be above 0 (process.kill(0)
// signals a process group), not main's own, and still the page's renderer in the same step. And no
// `forcefullyCrashRenderer` in main's webview code: on a Linux host that pipes cores to
// systemd-coredump that crash holds the renderer 40 s and more before `render-process-gone`. The
// test-run crash hook (windows/electron-window-factory.ts) is the one other use.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')
const ALLOWED = new Map([
  ['src/main/webview/renderer-kill.ts', ['getOSProcessId']],
  ['src/main/windows/electron-window-factory.ts', ['forcefullyCrashRenderer']]
].map(([p, names]) => [(p as string).split('/').join(sep), names as string[]]))

const FORBIDDEN: Array<[string, RegExp]> = [
  ['getOSProcessId', /\bgetOSProcessId\s*\(/],
  ['forcefullyCrashRenderer', /\bforcefullyCrashRenderer\s*\(/]
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Code lines only: a comment may name the rule it follows. */
function offences(file: string, text: string, allowed: readonly string[] = []): string[] {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
    .filter(({ text: t }) => FORBIDDEN.some(([name, re]) => !allowed.includes(name) && re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

describe('no renderer pid or renderer kill outside renderer-kill.ts', () => {
  it('finds none in src', () => {
    const found = sources(SRC).flatMap((p) => {
      const rel = relative(ROOT, p)
      return offences(rel, readFileSync(p, 'utf8'), ALLOWED.get(rel))
    })
    expect(found).toEqual([])
  })

  it('every allowed file still exists and uses it', () => {
    for (const f of ALLOWED.keys()) expect(offences(f, readFileSync(join(ROOT, f), 'utf8')).length, f).toBeGreaterThan(0)
  })

  it('catches each form it forbids and ignores comments', () => {
    const sample = ['const pid = wc.getOSProcessId()', 'wc.forcefullyCrashRenderer()', '// getOSProcessId() is read in renderer-kill.ts', ' * forcefullyCrashRenderer() dumps core', 'wc.mainFrame.osProcessId'].join('\n')
    expect(offences('x.ts', sample)).toEqual(['x.ts:1', 'x.ts:2'])
  })
})
