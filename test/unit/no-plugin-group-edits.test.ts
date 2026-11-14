import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Split groups and plugins (team run 001 design §1 "Plugin API", decisions D4, D7; security review
// of task 02): a plugin reaches the person's arrangement in exactly one way, the `beside` of its own
// open, which main applies through TabGroups.createBeside with `{ plugin: true }` (only the new tab,
// fewer than 4 panes, never focused). No plugin path may move, remove, resize, reorder, dissolve or
// rename a group. Checked on the code of the plugin side of main (src/main/plugins) and of the plugin
// host (src/host): neither imports the groups model or service, nor names a groups channel; and the
// one plugin open path in index.ts passes `{ plugin: true }`.

const ROOT = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : []
  })
}

// The module (either the pure model or main's service) as an import specifier, and the channel names.
const FORBIDDEN = [/(['"`])[^'"`]*tab-groups\1/, /(['"`])groups\.(get|place|remove|dissolve|resize|rename|changed)\1/, /\bTabGroups\b/]

/** Code lines only: a comment may name them. */
function offences(file: string, text: string): string[] {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
    .filter(({ text: t }) => FORBIDDEN.some((re) => re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

describe('plugins reach split groups only through beside', () => {
  it('nothing on the plugin side of main or in the plugin host imports the groups or names a groups channel', () => {
    const files = [...sources(join(ROOT, 'src', 'main', 'plugins')), ...sources(join(ROOT, 'src', 'host'))]
    expect(files.length).toBeGreaterThan(10)
    const found = files.flatMap((p) => offences(relative(ROOT, p), readFileSync(p, 'utf8')))
    expect(found).toEqual([])
  })

  it('the plugin open path places with { plugin: true }, and it is the only createBeside a plugin reaches', () => {
    const index = readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8')
    const start = index.indexOf('const announcePluginTab = (')
    expect(start).toBeGreaterThan(0)
    const body = index.slice(start, index.indexOf('\n  }\n', start))
    expect(body).toContain('tabGroups.createBeside(projectId, beside, create, { plugin: true })')
    // Two calls in all: this one and the person's `tabs.create` (no plugin flag, the page's own split).
    expect(index.match(/tabGroups\.createBeside\(/g)).toHaveLength(2)
  })
})
