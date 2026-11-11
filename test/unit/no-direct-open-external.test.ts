import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Server mode (design-web.md §9 "shell.openExternal"): a link must never open the host's browser
// there, and on the desktop a browser view's link is a notice in that view. One adapter decides
// (src/main/external/open-external.ts); only its Electron side may call `shell.openExternal`, and
// only the adapter sends `app.linkNotice`, so a new call site cannot skip the decision.

const ROOT = join(__dirname, '..', '..')
const MAIN = join(ROOT, 'src', 'main')
const SHELL_ALLOWED = new Set(['src/main/external/electron-open-external.ts'].map((p) => p.split('/').join(sep)))
const NOTICE_ALLOWED = new Set(['src/main/external/open-external.ts'].map((p) => p.split('/').join(sep)))

const SHELL_FORBIDDEN = [
  // Electron's `shell.openExternal`, called or captured (`const o = shell.openExternal`).
  /(?<![\w.])shell\s*\??\.\s*openExternal\b/,
  // Destructured from electron's shell or required straight off the module.
  /\{[^}]*\bopenExternal\b[^}]*\}\s*=\s*shell\b/,
  /require\(\s*['"]electron['"]\s*\)\s*\.\s*shell\b/
]
const NOTICE_FORBIDDEN = [/['"`]app\.linkNotice['"`]/]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** `file:line` of every code line (comments skipped: they may name the rule) matching a pattern. */
function offences(file: string, text: string, patterns: RegExp[]): string[] {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
    .filter(({ text: t }) => patterns.some((re) => re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

function scan(allowed: Set<string>, patterns: RegExp[]): string[] {
  return sources(MAIN).flatMap((p) => {
    const rel = relative(ROOT, p)
    return allowed.has(rel) ? [] : offences(rel, readFileSync(p, 'utf8'), patterns)
  })
}

describe('one adapter for shell.openExternal', () => {
  it('only the Electron side of the adapter calls shell.openExternal', () => {
    expect(scan(SHELL_ALLOWED, SHELL_FORBIDDEN)).toEqual([])
  })

  it('only the adapter sends app.linkNotice', () => {
    expect(scan(NOTICE_ALLOWED, NOTICE_FORBIDDEN)).toEqual([])
  })

  it('every allowed file still exists', () => {
    const all = new Set(sources(MAIN).map((p) => relative(ROOT, p)))
    for (const f of [...SHELL_ALLOWED, ...NOTICE_ALLOWED]) expect(all.has(f), f).toBe(true)
  })

  it('catches each form it forbids and ignores comments and other members', () => {
    const sample = [
      'shell.openExternal(url)',
      'await shell.openExternal(href).catch(() => {})',
      'const open = shell.openExternal',
      'const { openExternal } = shell',
      "require('electron').shell.openExternal(u)",
      "views.toView(v, 'app.linkNotice', { url })",
      '// shell.openExternal is not allowed here',
      " * 'app.linkNotice' in a doc comment",
      'openExternal(url, { windowId })',
      'this.shell.openExternal(x)',
      'deps.openExternal(href)'
    ].join('\n')
    expect(offences('x.ts', sample, [...SHELL_FORBIDDEN, ...NOTICE_FORBIDDEN])).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:3', 'x.ts:4', 'x.ts:5', 'x.ts:6'])
  })
})
