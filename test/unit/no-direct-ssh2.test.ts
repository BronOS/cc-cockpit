import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// The ssh2 library (design-remote-desktop.md §8 "The library") is a new dependency in a security
// path: only the adapter src/main/remote/ssh-client.ts imports it, so what main uses of it (Client,
// utils.parseKey; never debug, never Server) is decided and reviewed in one file. Covers every source
// under src/, renderer and plugin host included, since none of them may reach it either.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')
const ALLOWED = new Set(['src/main/remote/ssh-client.ts'].map((p) => p.split('/').join(sep)))

// The module name, alone or with a subpath (`ssh2/lib/client.js`), in quotes: an import, an export
// from, a type import, a require or a dynamic import all carry it as a string literal.
const FORBIDDEN = [/(['"`])ssh2(\/[^'"`]*)?\1/]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : []
  })
}

/** Code lines only: a comment may name the library. */
function offences(file: string, text: string): string[] {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
    .filter(({ text: t }) => FORBIDDEN.some((re) => re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

describe('ssh2 only through the adapter', () => {
  it('finds no other import of ssh2 under src', () => {
    const found = sources(SRC).flatMap((p) => {
      const rel = relative(ROOT, p)
      return ALLOWED.has(rel) ? [] : offences(rel, readFileSync(p, 'utf8'))
    })
    expect(found).toEqual([])
  })

  it('the adapter exists and imports it', () => {
    for (const f of ALLOWED) expect(offences(f, readFileSync(join(ROOT, f), 'utf8')).length, f).toBeGreaterThan(0)
  })

  it('the remote code spawns no process (the system `ssh` is gone: remote SSH rev 2)', () => {
    const remote = join(SRC, 'main', 'remote')
    const spawning = /(['"`])(node:)?child_process\1/
    const found = sources(remote).flatMap((p) =>
      readFileSync(p, 'utf8')
        .split('\n')
        .map((t, i) => ({ line: i + 1, text: t }))
        .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t) && spawning.test(t))
        .map(({ line }) => `${relative(ROOT, p)}:${line}`)
    )
    expect(found).toEqual([])
  })

  it('catches each form it forbids and ignores comments and look-alikes', () => {
    const sample = [
      "import { Client } from 'ssh2'",
      'import type { ParsedKey } from "ssh2"',
      "const ssh2 = require('ssh2')",
      "const m = await import('ssh2')",
      "import { parseKey } from 'ssh2/lib/protocol/keyParser.js'",
      "export { Client } from 'ssh2'",
      '// imported from \'ssh2\' only in the adapter',
      ' * see ssh2 docs',
      "import x from 'ssh2-sftp-client'",
      "const name = 'ssh2x'",
      'const ssh2 = 1'
    ].join('\n')
    expect(offences('x.ts', sample)).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:3', 'x.ts:4', 'x.ts:5', 'x.ts:6'])
  })
})
