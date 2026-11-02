import { describe, expect, it } from 'vitest'
import {
  MAX_INDEX_BYTES,
  MAX_INDEX_PLUGINS,
  MAX_INDEX_REVOCATIONS,
  MAX_NAME_LENGTH,
  compareVersions,
  parseEntry,
  parseMarketplaceIndex,
  parseRevocation,
  plainDisplayText,
} from '../../src/shared/marketplace'
import { gitUrlProblem } from '../../src/shared/git-source'

const HTTPS = 'https://example.com/index.json'
const FILE = 'file:///tmp/index.json'
const C1 = 'a'.repeat(40)
const C2 = 'b'.repeat(40)

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme.jira',
    name: 'Jira',
    description: 'Tickets',
    author: 'Acme',
    repo: 'https://github.com/acme/jira.git',
    version: '0.3.0',
    tag: 'v0.3.0',
    commit: C1,
    api: 1,
    ...over,
  }
}

function index(plugins: unknown[], revoked?: unknown[]): string {
  return JSON.stringify({
    schema: 1,
    plugins,
    ...(revoked ? { revoked } : {}),
  })
}

describe('parseMarketplaceIndex', () => {
  it('accepts a valid index with a revocation', () => {
    const r = parseMarketplaceIndex(
      index(
        [entry()],
        [{ id: 'acme.jira', commit: C2, reason: 'leaks tokens' }],
      ),
      {
        indexUrl: HTTPS,
      },
    )
    expect(r).toMatchObject({
      ok: true,
      skippedEntries: 0,
      skippedRevocations: 0,
    })
    if (!r.ok) return
    expect(r.index.plugins).toEqual([entry()])
    expect(r.index.revoked).toEqual([
      { id: 'acme.jira', commit: C2, reason: 'leaks tokens' },
    ])
  })

  it('treats a missing revoked list as empty', () => {
    const r = parseMarketplaceIndex(index([entry()]), { indexUrl: HTTPS })
    expect(r.ok && r.index.revoked).toEqual([])
  })

  it('drops and counts bad entries but keeps the good ones', () => {
    const r = parseMarketplaceIndex(
      index([
        entry(),
        entry({ id: 'Bad Id' }),
        entry({ id: 'acme.b', tag: '--evil' }),
        entry({ id: 'acme.c', version: 'x' }),
        entry({ id: 'acme.d', repo: 'git@github.com:a/b.git' }),
        entry({ id: 'acme.e', api: 0 }),
        entry({ id: 'acme.f', name: '' }),
        'nope',
      ]),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.index.plugins.map((e) => e.id)).toEqual(['acme.jira'])
    expect(r.ok && r.skippedEntries).toBe(7)
  })

  it('drops and counts bad revocations', () => {
    const r = parseMarketplaceIndex(
      index(
        [],
        [
          { id: 'acme.x', commit: C1, reason: 'ok' },
          { id: 'acme.x', commit: 'short', reason: 'r' },
          { id: 'nope' },
          3,
        ],
      ),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.index.revoked).toHaveLength(1)
    expect(r.ok && r.skippedRevocations).toBe(3)
  })

  it('drops and counts a listing under a reserved cockpit. id: the app ships those itself', () => {
    const r = parseMarketplaceIndex(index([entry(), entry({ id: 'cockpit.jira' })]), { indexUrl: HTTPS })
    expect(r.ok && r.index.plugins.map((e) => e.id)).toEqual(['acme.jira'])
    expect(r.ok && r.skippedEntries).toBe(1)
    const one = parseEntry(entry({ id: 'cockpit.jira' }), HTTPS)
    expect(one.ok ? null : one.problem).toMatch(/^"id": ids starting with cockpit\. are reserved/)
  })

  it('drops every entry sharing a duplicate id', () => {
    const r = parseMarketplaceIndex(
      index([entry(), entry({ commit: C2 }), entry({ id: 'acme.other' })]),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.index.plugins.map((e) => e.id)).toEqual(['acme.other'])
    expect(r.ok && r.skippedEntries).toBe(2)
  })

  it('refuses an unknown or missing schema', () => {
    expect(
      parseMarketplaceIndex(JSON.stringify({ schema: 2, plugins: [] }), {
        indexUrl: HTTPS,
      }).ok,
    ).toBe(false)
    expect(
      parseMarketplaceIndex(JSON.stringify({ plugins: [] }), {
        indexUrl: HTTPS,
      }).ok,
    ).toBe(false)
  })

  it('refuses invalid JSON and non-objects', () => {
    expect(parseMarketplaceIndex('{nope', { indexUrl: HTTPS }).ok).toBe(false)
    expect(parseMarketplaceIndex('[]', { indexUrl: HTTPS }).ok).toBe(false)
    expect(
      parseMarketplaceIndex(JSON.stringify({ schema: 1 }), { indexUrl: HTTPS })
        .ok,
    ).toBe(false)
    expect(
      parseMarketplaceIndex(
        JSON.stringify({ schema: 1, plugins: [], revoked: 'x' }),
        { indexUrl: HTTPS },
      ).ok,
    ).toBe(false)
  })

  it('enforces the caps', () => {
    const many = Array.from({ length: MAX_INDEX_PLUGINS + 1 }, () => entry())
    expect(parseMarketplaceIndex(index(many), { indexUrl: HTTPS }).ok).toBe(
      false,
    )
    const rev = Array.from({ length: MAX_INDEX_REVOCATIONS + 1 }, () => ({
      id: 'acme.x',
      commit: C1,
      reason: '',
    }))
    expect(parseMarketplaceIndex(index([], rev), { indexUrl: HTTPS }).ok).toBe(
      false,
    )
    // Valid JSON padded past the cap, so only the size check can refuse it.
    const big = parseMarketplaceIndex(
      JSON.stringify({ schema: 1, plugins: [], pad: ' '.repeat(MAX_INDEX_BYTES) }),
      { indexUrl: HTTPS },
    )
    expect(big).toEqual({ ok: false, error: 'the index is too large' })
    for (const field of ['id', 'name', 'author', 'version', 'tag', 'repo']) {
      const r = parseMarketplaceIndex(
        index([entry({ [field]: 'x'.repeat(2001) })]),
        { indexUrl: HTTPS },
      )
      expect(r.ok && r.skippedEntries, field).toBe(1)
    }
    const longReason = parseMarketplaceIndex(
      index([], [{ id: 'acme.x', commit: C1, reason: 'x'.repeat(1001) }]),
      { indexUrl: HTTPS },
    )
    expect(longReason.ok && longReason.skippedRevocations).toBe(1)
    const long = parseMarketplaceIndex(
      index([entry({ description: 'x'.repeat(1001) })]),
      { indexUrl: HTTPS },
    )
    expect(long.ok && long.skippedEntries).toBe(1)
  })

  it('rejects a commit that is short, uppercase or not hex', () => {
    for (const commit of [
      'abc123',
      'A'.repeat(40),
      'g'.repeat(40),
      C1 + 'a',
      42,
    ]) {
      const r = parseMarketplaceIndex(index([entry({ commit })]), {
        indexUrl: HTTPS,
      })
      expect(r.ok && r.skippedEntries, String(commit)).toBe(1)
    }
  })

  it('refuses a file: repo from an https: index, accepts it from a file: index', () => {
    const e = entry({ repo: 'file:///tmp/repo.git' })
    const remote = parseMarketplaceIndex(index([e]), { indexUrl: HTTPS })
    expect(remote.ok && remote.index.plugins).toHaveLength(0)
    expect(remote.ok && remote.skippedEntries).toBe(1)
    const local = parseMarketplaceIndex(index([e]), { indexUrl: FILE })
    expect(local.ok && local.index.plugins).toHaveLength(1)
  })

  it('refuses a git@ repo even from a file: index', () => {
    const r = parseMarketplaceIndex(
      index([entry({ repo: 'git@github.com:a/b.git' })]),
      { indexUrl: FILE },
    )
    expect(r.ok && r.skippedEntries).toBe(1)
  })

  it('refuses a null revoked field instead of treating it as empty', () => {
    const r = parseMarketplaceIndex(
      JSON.stringify({ schema: 1, plugins: [], revoked: null }),
      { indexUrl: HTTPS },
    )
    expect(r.ok).toBe(false)
  })

  it('bounds the schema echoed in the error', () => {
    const r = parseMarketplaceIndex(
      JSON.stringify({ schema: 'x'.repeat(100000), plugins: [] }),
      { indexUrl: HTTPS },
    )
    expect(!r.ok && r.error.length).toBeLessThan(100)
  })

  it('drops a valid entry whose id is shared with a malformed one', () => {
    const r = parseMarketplaceIndex(
      index([entry(), entry({ commit: 'bad' })]),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.index.plugins).toHaveLength(0)
    expect(r.ok && r.skippedEntries).toBe(2)
  })

  it('refuses blank, control and bidi characters in name and author', () => {
    for (const bad of ['   ', 'a\u0007b', 'a\u202eb', 'a\u2066b']) {
      for (const field of ['name', 'author']) {
        const r = parseMarketplaceIndex(index([entry({ [field]: bad })]), {
          indexUrl: HTTPS,
        })
        expect(r.ok && r.skippedEntries, `${field} ${JSON.stringify(bad)}`).toBe(1)
      }
    }
  })

  it('refuses a backslash in an https repo', () => {
    const r = parseMarketplaceIndex(
      index([entry({ repo: 'https://github.com\\@evil.com/x.git' })]),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.skippedEntries).toBe(1)
    expect(gitUrlProblem('https://github.com\\@evil.com/x.git')).not.toBeNull()
  })

  it('refuses unsafe characters in a description, a line break aside', () => {
    for (const bad of ['a\u0007b', 'a\u202eb', 'a\tb']) {
      const r = parseMarketplaceIndex(index([entry({ description: bad })]), {
        indexUrl: HTTPS,
      })
      expect(r.ok && r.skippedEntries, JSON.stringify(bad)).toBe(1)
    }
    const r = parseMarketplaceIndex(
      index([entry({ description: 'one\ntwo' })]),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.index.plugins[0]?.description).toBe('one\ntwo')
  })

  it('cleans a revocation reason and keeps the row: prose must not re-enable a commit', () => {
    const r = parseMarketplaceIndex(
      index(
        [],
        [{ id: 'acme.jira', commit: C1, reason: 'bad\n\u202ecommit' }],
      ),
      { indexUrl: HTTPS },
    )
    expect(r.ok && r.skippedRevocations).toBe(0)
    expect(r.ok && r.index.revoked[0]?.reason).toBe('bad  commit')
  })

  it('refuses a non-ASCII repo host, accepts its punycode', () => {
    // Cyrillic "а" in github.
    const homograph = 'https://gith\u0430b.com/a/b.git'
    expect(
      parseEntry(entry({ repo: homograph }), HTTPS),
    ).toMatchObject({ ok: false, problem: expect.stringContaining('ASCII') })
    expect(
      parseEntry(entry({ repo: 'https://xn--githb-7ve.com/a/b.git' }), HTTPS).ok,
    ).toBe(true)
  })

  it('names the field in a problem, and never echoes its value', () => {
    const r = parseEntry(entry({ commit: 'secret-looking-value' }), HTTPS)
    expect(r).toMatchObject({ ok: false, problem: expect.stringContaining('"commit"') })
    expect(JSON.stringify(r)).not.toContain('secret-looking-value')
    expect(parseEntry(null, HTTPS).ok).toBe(false)
    expect(parseRevocation({ id: 'acme.jira', commit: 'x', reason: '' })).toMatchObject({
      ok: false,
      problem: expect.stringContaining('"commit"'),
    })
  })

  it('takes every text field up to its cap, whatever the bytes, and refuses one more', () => {
    const ok = (over: Record<string, unknown>): boolean =>
      parseEntry(entry(over), HTTPS).ok
    // The caps count characters (UTF-16 units): a multi-byte name is no shorter or longer for it.
    expect(ok({ name: '\u00e9'.repeat(MAX_NAME_LENGTH) })).toBe(true)
    expect(ok({ name: '\u00e9'.repeat(MAX_NAME_LENGTH + 1) })).toBe(false)
    expect(ok({ author: '\u65e5'.repeat(100) })).toBe(true)
    expect(ok({ author: '\u65e5'.repeat(101) })).toBe(false)
    expect(ok({ description: '\u00e9'.repeat(1000) })).toBe(true)
    expect(ok({ description: '\u00e9'.repeat(1001) })).toBe(false)
    expect(ok({ tag: 'x'.repeat(200) })).toBe(true)
    expect(ok({ tag: 'x'.repeat(201) })).toBe(false)
    const repo = (n: number): string => {
      const prefix = 'https://github.com/'
      return prefix + 'x'.repeat(n - prefix.length)
    }
    expect(ok({ repo: repo(2000) })).toBe(true)
    expect(ok({ repo: repo(2001) })).toBe(false)
  })
})

describe('plainDisplayText', () => {
  it('flattens, strips markup brackets and unsafe characters, and caps', () => {
    expect(plainDisplayText('a\n\t b', 50)).toBe('a b')
    expect(plainDisplayText('<b>x</b>', 50)).toBe('bx/b')
    expect(plainDisplayText('a\u202eb\u2028c', 50)).toBe('a b c')
    expect(plainDisplayText('x'.repeat(10), 5)).toBe('xxxx…')
    expect(plainDisplayText('x'.repeat(5), 5)).toBe('xxxxx')
  })
})

describe('compareVersions', () => {
  it('orders by numbers, then pre-release, ignoring build metadata', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0+build.5')).toBe(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1)
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBe(-1)
  })

  it('compares numeric pre-release identifiers as digit strings', () => {
    expect(compareVersions('1.0.0-01', '1.0.0-1')).toBe(0)
    expect(compareVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(1)
    expect(compareVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBe(-1)
  })

  it('compares core numbers as digit strings: past 2^53 a downgrade is not an update', () => {
    expect(compareVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBe(1)
    expect(compareVersions('9007199254740992.1.0', '9007199254740993.0.0')).toBe(-1)
    expect(compareVersions('9007199254740993.0.0', '9007199254740992.1.0')).toBe(1)
    expect(compareVersions('1.9007199254740993.0', '1.9007199254740992.5')).toBe(1)
    expect(compareVersions('10.0.0', '9.0.0')).toBe(1)
    expect(compareVersions('01.0.0', '1.0.0')).toBe(0)
  })

  it('fails towards "not newer" on what the pattern would not pass', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1', '1.0.1')).toBe(-1)
    expect(compareVersions('', '0.0.0')).toBe(0)
  })
})
