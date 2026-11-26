// The `notes` extra of an overlay spec (shared/design.md §3, 00 contract): parseOverlayExtras accepts a key on a
// plugin page's html overlay of a perView opener and refuses everything else, the whole open with it (fail closed:
// never an overlay opened without the notes its page expects).
import { describe, expect, it } from 'vitest'
import { parseOverlayExtras } from '../../src/shared/overlay-buttons'
import { isNotesKey, MAX_NOTES_KEY } from '../../src/shared/notes-limits'

const file = (notes: unknown): Record<string, unknown> => ({ kind: 'html', file: 'doc.html', notes })

describe('overlay spec notes', () => {
  it('accepts a key on an html file overlay of a perView opener (and the host\'s early parse, no context)', () => {
    expect(parseOverlayExtras(file({ key: 'jira:PROJ-123' }), 'html', { perView: true }).notes).toEqual({ key: 'jira:PROJ-123' })
    expect(parseOverlayExtras(file({ key: 'a'.repeat(MAX_NOTES_KEY) }), 'html', { perView: true }).notes?.key).toHaveLength(MAX_NOTES_KEY)
    expect(parseOverlayExtras(file({ key: 'x._:@#+=~/-9' }), 'html').notes).toEqual({ key: 'x._:@#+=~/-9' })
    // Only the key is kept: nothing else of the opener's object rides along.
    expect(parseOverlayExtras(file({ key: 'k', extra: 1 }), 'html', { perView: true }).notes).toEqual({ key: 'k' })
    expect(parseOverlayExtras({ kind: 'html', file: 'doc.html' }, 'html', { perView: true })).not.toHaveProperty('notes')
  })

  it('notes refused: key over 200, outside ANNOTATE_KEY_CHARS, not a string, not an html file, opener not perView', () => {
    const refused = (s: Record<string, unknown>, kind = 'html', perView: boolean | undefined = true): void => {
      expect(() => parseOverlayExtras(s, kind, perView === undefined ? {} : { perView }), JSON.stringify(s)).toThrow(/notes/)
    }
    refused(file({ key: 'a'.repeat(MAX_NOTES_KEY + 1) }))
    for (const key of ['', 'a b', 'a\nb', 'ü', 'a?b', 'a&b', 'a\\b', '<x>', 'a;b']) refused(file({ key }))
    for (const key of [undefined, null, 7, ['k'], { k: 1 }]) refused(file({ key }))
    for (const notes of [null, 'k', 7, true, ['k']]) refused(file(notes))
    refused({ kind: 'terminal', argv: ['sh'], notes: { key: 'k' } }, 'terminal')
    refused({ kind: 'url', url: 'https://x.test', notes: { key: 'k' } }, 'url')
    refused({ kind: 'html', html: '<p>x</p>', notes: { key: 'k' } })
    refused(file({ key: 'k' }), 'html', false)
  })

  it('isNotesKey is the one rule', () => {
    expect(isNotesKey('ok-key/1')).toBe(true)
    expect(isNotesKey('a'.repeat(MAX_NOTES_KEY))).toBe(true)
    for (const v of ['', 'a'.repeat(MAX_NOTES_KEY + 1), 'a b', 3, null, undefined, {}]) expect(isNotesKey(v)).toBe(false)
  })
})
