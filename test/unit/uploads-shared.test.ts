import { describe, expect, it } from 'vitest'
import { MAX_NAME_NUMBER, numberedName } from '../../src/shared/numbered-name'
import {
  UPLOAD_MAX_NAME_NUMBER,
  checkUploadName,
  dedupeNames,
  insideGit,
  pasteText,
  pastedName,
} from '../../src/shared/uploads'

const refused = (name: unknown): string | undefined => {
  const check = checkUploadName(name)
  return check.ok ? undefined : check.reason
}

describe('checkUploadName', () => {
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['dot', '.'],
    ['dot dot', '..'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\0b'],
    ['256 bytes', 'a'.repeat(256)],
    ['256 bytes of two-byte letters', 'ж'.repeat(128)],
    ['RIGHT-TO-LEFT OVERRIDE', 'report‮fdp.exe'],
    ['BEL', 'a\u0007b'],
    ['ESC', 'a\u001b[31m'],
    ['newline', 'a\nb'],
    ['a lone high surrogate', 'a\ud800b'],
    ['a lone low surrogate', 'a\udc00b'],
  ])('refuses %s', (_, name) => {
    expect(refused(name)).toBeTruthy()
  })

  it('refuses what is not a string', () => {
    expect(refused(undefined)).toBeTruthy()
    expect(refused(42)).toBeTruthy()
  })

  it.each([
    ['a dot file', '.env'],
    ['a plain name', 'report.pdf'],
    ['255 bytes', 'a'.repeat(255)],
    ['a macOS screenshot name with U+202F', 'Screenshot 2026-11-22 at 10.15.03 AM.png'],
    ['a Cyrillic name', 'Снимок экрана.png'],
    ['an emoji (a surrogate pair)', 'photo 😀.jpg'],
    ['shell characters', "it's $(x) & [y].txt"],
  ])('allows %s', (_, name) => {
    expect(checkUploadName(name)).toEqual({ ok: true })
  })
})

describe('pastedName', () => {
  const date = new Date(2026, 10, 2, 9, 5, 7)

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['application/pdf', 'pdf'],
    ['IMAGE/PNG', 'png'],
    ['image/png; charset=binary', 'png'],
    ['image/svg+xml', 'bin'],
    ['text/html', 'bin'],
    ['', 'bin'],
  ])('names %j .%s from the device clock', (type, ext) => {
    expect(pastedName(type, date)).toBe(`pasted-20261102-090507.${ext}`)
  })
})

describe('dedupeNames', () => {
  it('numbers repeats case-insensitively, keeping the first', () => {
    expect(dedupeNames(['a.txt', 'A.TXT', 'b', 'a.txt'])).toEqual(['a.txt', 'A (1).TXT', 'b', 'a (2).txt'])
  })

  it('takes the next number when an earlier name holds it', () => {
    expect(dedupeNames(['a (1).txt', 'a.txt', 'a.txt'])).toEqual(['a (1).txt', 'a.txt', 'a (2).txt'])
  })

  it('treats composed and decomposed letters as one name', () => {
    expect(dedupeNames(['café', 'café'])).toEqual(['café', 'café (1)'])
  })

  it('numbers a dot file and a double extension the Keep both way', () => {
    expect(dedupeNames(['.env', '.env', 'a.tar.gz', 'a.tar.gz'])).toEqual(['.env', '.env (1)', 'a.tar.gz', 'a.tar (1).gz'])
  })

  it('numbers up to 99, then gives null', () => {
    expect(UPLOAD_MAX_NAME_NUMBER).toBe(99)
    const out = dedupeNames(Array.from({ length: 101 }, () => 'x.png'))
    expect(out[99]).toBe('x (99).png')
    expect(out[100]).toBeNull()
    expect(new Set(out.slice(0, 100)).size).toBe(100)
  })
})

describe('numberedName (shared with the remote window)', () => {
  it('puts the number before the last extension, never after a leading dot', () => {
    expect(numberedName('report.pdf', 0)).toBe('report.pdf')
    expect(numberedName('.env', 1)).toBe('.env (1)')
    expect(numberedName('a.tar.gz', 1)).toBe('a.tar (1).gz')
    expect(numberedName('notes', MAX_NAME_NUMBER)).toBe('notes (99)')
  })
})

describe('insideGit', () => {
  it('refuses .git and anything below it, named or real', () => {
    expect(insideGit('.git', '.git', false)).toBe(true)
    expect(insideGit('sub/.git/hooks', 'sub/.git/hooks', false)).toBe(true)
    expect(insideGit('hooks-link', '.git/hooks', false)).toBe(true)
    expect(insideGit('.git/hooks', 'elsewhere', false)).toBe(true)
  })

  it('compares case-insensitively on darwin only', () => {
    expect(insideGit('.GIT/hooks', '.GIT/hooks', true)).toBe(true)
    expect(insideGit('sub/.Git', 'sub/.Git', true)).toBe(true)
    expect(insideGit('.GIT/hooks', '.GIT/hooks', false)).toBe(false)
  })

  it('allows the project folder and names that only start with .git', () => {
    expect(insideGit('', '', true)).toBe(false)
    expect(insideGit('.github/workflows', '.github/workflows', true)).toBe(false)
    expect(insideGit('src/.gitkeep-dir', 'src/.gitkeep-dir', true)).toBe(false)
    expect(insideGit('a.git', 'a.git', true)).toBe(false)
  })
})

describe('pasteText', () => {
  it('escapes ASCII space, tab and every shell-special ASCII character', () => {
    for (const ch of [' ', '\t', ...'\\\'"`$&*()[]{};|<>?!#~']) {
      expect(pasteText([`a${ch}b`])).toBe(`a\\${ch}b `)
    }
  })

  it('leaves other ASCII alone', () => {
    expect(pasteText(['/p/a-b_c.d,e=f+g@h%i^j:k'])).toBe('/p/a-b_c.d,e=f+g@h%i^j:k ')
  })

  it('keeps every non-ASCII character as it is', () => {
    expect(pasteText(['/p/Снимок.png'])).toBe('/p/Снимок.png ')
    expect(pasteText(['./Screenshot AM.png'])).toBe('./Screenshot AM.png ')
    expect(pasteText(['./Screenshot at 10.png'])).toBe('./Screenshot\\ at\\ 10.png ')
  })

  it('separates paths by a space with one trailing space', () => {
    expect(pasteText(['/a/x.png', '../b/y z.pdf'])).toBe('/a/x.png ../b/y\\ z.pdf ')
    expect(pasteText([])).toBe('')
  })
})
