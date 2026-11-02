import { describe, expect, it } from 'vitest'
import {
  diffArgv,
  GIT_DIFF_FLAGS,
  lsFilesArgv,
  type LsFiles,
  type LsFilesResult
} from '../../src/main/sessions/diff-argv'

const CWD = '/work/project'
const G = ['git', ...GIT_DIFF_FLAGS]

/** A probe that answers `result` and records what it was asked. */
function probe(result: LsFilesResult | Error): { fn: LsFiles; calls: Array<{ argv: string[]; cwd: string }> } {
  const calls: Array<{ argv: string[]; cwd: string }> = []
  return {
    calls,
    fn: async (argv, cwd) => {
      calls.push({ argv, cwd })
      if (result instanceof Error) throw result
      return result
    }
  }
}

describe('diffArgv', () => {
  it('diffs a tracked file against the index', async () => {
    const p = probe({ code: 0 })
    expect(await diffArgv('src/a.ts', CWD, p.fn)).toEqual([...G, 'diff', '--', '/work/project/src/a.ts'])
    // The probe ran in the tab's cwd with the same absolute path.
    expect(p.calls).toEqual([
      {
        argv: ['git', '--literal-pathspecs', 'ls-files', '--error-unmatch', '--', '/work/project/src/a.ts'],
        cwd: CWD
      }
    ])
  })

  it('diffs an untracked file against /dev/null', async () => {
    expect(await diffArgv('new.ts', CWD, probe({ code: 1 }).fn)).toEqual([
      ...G,
      'diff',
      '--no-index',
      '--',
      '/dev/null',
      '/work/project/new.ts'
    ])
  })

  it('shows a file outside any repository with less', async () => {
    // git ls-files exits 128 for "not a git repository" and for "outside repository".
    expect(await diffArgv('/tmp/notes.txt', CWD, probe({ code: 128 }).fn)).toEqual([
      'less',
      '-+F',
      '--',
      '/tmp/notes.txt'
    ])
  })

  it('falls back to less when git cannot run at all', async () => {
    expect(await diffArgv('a.ts', CWD, probe({ code: null, spawnFailed: true }).fn)).toEqual([
      'less',
      '-+F',
      '--',
      '/work/project/a.ts'
    ])
    expect(await diffArgv('a.ts', CWD, probe(new Error('boom')).fn)).toEqual(['less', '-+F', '--', '/work/project/a.ts'])
  })

  it('keeps the pager up on a diff that fits one screen', async () => {
    // The overlay closes with its program; git's default LESS=FRX would quit at once on a
    // 3-line diff. Forced pager without quit-if-one-screen, before the subcommand.
    for (const code of [0, 1]) {
      const argv = await diffArgv('a.ts', CWD, probe({ code }).fn)
      const pager = argv.indexOf('core.pager=less -R -+F')
      expect(argv[pager - 1]).toBe('-c')
      expect(argv).toContain('--paginate')
      expect(pager).toBeLessThan(argv.indexOf('diff'))
    }
  })

  it('reads glob characters in a path literally', async () => {
    // `app/[id]/page.tsx` as a pathspec also matches a tracked `app/i/page.tsx`.
    const p = probe({ code: 0 })
    const argv = await diffArgv('app/[id]/page.tsx', CWD, p.fn)
    expect(argv.indexOf('--literal-pathspecs')).toBeLessThan(argv.indexOf('diff'))
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', '/work/project/app/[id]/page.tsx'])
    const probeArgv = p.calls[0]!.argv
    expect(probeArgv.indexOf('--literal-pathspecs')).toBeLessThan(probeArgv.indexOf('ls-files'))
  })

  it('keeps a path with spaces as one argv entry', async () => {
    expect(await diffArgv('my docs/a b.md', CWD, probe({ code: 0 }).fn)).toEqual([
      ...G,
      'diff',
      '--',
      '/work/project/my docs/a b.md'
    ])
  })

  it('never lets a leading dash reach git or less as an option', async () => {
    for (const code of [0, 1, 128]) {
      const argv = await diffArgv('-p', CWD, probe({ code }).fn)
      // Resolved against cwd, so the entry does not start with `-`, and `--` precedes it anyway.
      expect(argv.at(-1)).toBe('/work/project/-p')
      expect(argv).toContain('--')
      expect(argv.slice(argv.indexOf('--') + 1).every((a) => !a.startsWith('-'))).toBe(true)
    }
    expect(lsFilesArgv('/work/project/-p')).toEqual([
      'git',
      '--literal-pathspecs',
      'ls-files',
      '--error-unmatch',
      '--',
      '/work/project/-p'
    ])
    expect((await diffArgv('--output=x', CWD, probe({ code: 128 }).fn)).at(-1)).toBe('/work/project/--output=x')
  })

  it('maps the known phase-1 gaps by exit code alone', async () => {
    // Nested repo / untracked file deleted since: exit 1, shown as all-added (or a git error
    // under the pager). File in a registered submodule: exit 128, shown with less.
    expect(await diffArgv('nested/x.ts', CWD, probe({ code: 1 }).fn)).toContain('--no-index')
    expect((await diffArgv('sub/x.ts', CWD, probe({ code: 128 }).fn))[0]).toBe('less')
  })
})
