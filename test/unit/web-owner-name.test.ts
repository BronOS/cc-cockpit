// D-24 (design-guests): the owner's name guests see, a label with no risk: read tolerantly from app.json,
// patched strictly from the settings page, stored, and reset to "Host".
import { describe, expect, it } from 'vitest'
import { applyWebAccessPatch, DEFAULT_OWNER_NAME, ownerNameIn, storedWebAccess, webAccessOf } from '../../src/main/web/settings'

const BEL = String.fromCharCode(7)

describe('owner name (D-24)', () => {
  it('reads a stored name as plain text, capped; a damaged one reads as none ("Host")', () => {
    expect(webAccessOf({ ownerName: `  Alice${BEL} ` }).ownerName).toBe('Alice')
    expect(webAccessOf({ ownerName: 'x'.repeat(200) }).ownerName).toHaveLength(60)
    expect(webAccessOf({ ownerName: 42 }).ownerName).toBeUndefined()
    expect(webAccessOf({ ownerName: BEL }).ownerName).toBeUndefined()
    expect(ownerNameIn(webAccessOf({}))).toBe(DEFAULT_OWNER_NAME)
    expect(ownerNameIn(webAccessOf({ ownerName: 'Alice' }))).toBe('Alice')
  })

  it('a patch sets it, null or blank resets it, a non-string is refused; it never needs a confirm', () => {
    const base = webAccessOf({ enabled: true })
    const set = applyWebAccessPatch(base, { ownerName: 'Oleg' })
    expect(set).toEqual({ ok: true, value: { ...base, ownerName: 'Oleg' } })
    if (!set.ok) throw new Error('refused')
    expect(applyWebAccessPatch(set.value, { ownerName: null })).toEqual({ ok: true, value: base })
    expect(applyWebAccessPatch(set.value, { ownerName: '  ' })).toEqual({ ok: true, value: base })
    expect(applyWebAccessPatch(base, { ownerName: 5 })).toMatchObject({ ok: false })
    expect(storedWebAccess({}, set.value).ownerName).toBe('Oleg')
    expect(storedWebAccess({ ownerName: 'Oleg' }, base)).not.toHaveProperty('ownerName')
  })
})
