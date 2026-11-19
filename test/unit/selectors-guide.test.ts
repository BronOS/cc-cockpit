import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// test/e2e/SELECTORS.md tells a spec writer who does not read the renderer which test id to use per shell
// surface (backlog: a blind QA lost a third of her e2e time guessing selectors). A guide naming an id the
// renderer no longer has is worse than none, so every `testid:<id>` the guide lists must still be in
// src/renderer as a whole string literal: most ids are written `data-testid="…"`, but ApprovalDialog's come
// through a prop (`testIds={{ allow: 'download-offer-accept' }}`) and some through `testId="…"`, so the
// attribute form alone would miss them, and a bare substring would let `guest-close` pass on `guest-close-ask`.
// An id with a variable part (`testid:web-access-row-<key>`) is checked by its template prefix
// (`` `web-access-row-${ ``). Checked on code lines: a comment naming an id does not keep it alive.

const ROOT = join(__dirname, '..', '..')
const GUIDE = join(ROOT, 'test', 'e2e', 'SELECTORS.md')
const RENDERER = join(ROOT, 'src', 'renderer')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((t) => !/^\s*(\/\/|\/?\*)/.test(t))
    .join('\n')

/** Every `testid:<id>` in the guide, in backticks; `<…>` marks a variable part. */
function guideIds(): string[] {
  const ids = [...readFileSync(GUIDE, 'utf8').matchAll(/`testid:([a-z0-9-]+(?:<[a-z]+>)?)`/g)].map((m) => m[1]!)
  return [...new Set(ids)].sort()
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('test/e2e/SELECTORS.md', () => {
  const code = sources(RENDERER)
    .map((p) => codeOf(readFileSync(p, 'utf8')))
    .join('\n')
  const ids = guideIds()

  it('lists test ids in its marker format', () => {
    // A floor: a changed marker would otherwise leave nothing to check and pass.
    expect(ids.length).toBeGreaterThanOrEqual(40)
    // Any backticked `testid` the extractor did not take (a typo in the marker) is a guide bug too.
    const loose = [...readFileSync(GUIDE, 'utf8').matchAll(/`testid[^`]*`/g)].map((m) => m[0]).filter((m) => !/^`testid:[a-z0-9-]+(?:<[a-z]+>)?`$/.test(m))
    expect(loose).toEqual([])
  })

  it('names only test ids that still exist in src/renderer', () => {
    const missing = ids.filter((id) => {
      const variable = id.indexOf('<')
      const re =
        variable < 0
          ? new RegExp(`(['"\`])${escape(id)}\\1`)
          : new RegExp(`\`${escape(id.slice(0, variable))}\\$\\{`)
      return !re.test(code)
    })
    expect(missing).toEqual([])
  })
})
