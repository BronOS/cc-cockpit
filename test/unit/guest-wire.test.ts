import { describe, expect, it } from 'vitest'
import { CLOSE, guestCloseText, INVITE_PATH, inviteLink, parseInviteFragment } from '../../src/shared/web-protocol'

// design-guests §2, §3, §10, §16.4: the invite link and the guest close codes.

describe('guest invites (design-guests §2, §3)', () => {
  const token = 'A'.repeat(42) + '_'
  const pin = 'ab'.repeat(32)

  it('reads the token and the pin from the fragment, nothing else', () => {
    expect(parseInviteFragment(`#i=${token}`)).toEqual({ token })
    expect(parseInviteFragment(`i=${token}&c=${pin}`)).toEqual({ token, cert: pin })
    expect(parseInviteFragment(inviteLink('https://h:7777', token, pin).split('#')[1]!)).toEqual({ token, cert: pin })
    expect(inviteLink('https://h:7777', token)).toBe(`https://h:7777/#i=${token}`)
    for (const bad of ['', '#', '#i=short', `#i=${token}x`, `#i=${token.slice(1)}!`, `#c=${pin}`, `#i=${token}&i=${token}`,
      `#i=${token}&c=${pin.toUpperCase()}`, `#i=${token}&x=1`, `#i=${token}&c=${pin}0`, '#' + 'i='.repeat(200)]) {
      expect(parseInviteFragment(bad), bad.slice(0, 40)).toBeUndefined()
    }
  })

  it('gives the guest close codes their own numbers and texts', () => {
    const codes = [CLOSE.guestProject, CLOSE.kicked, CLOSE.roleChanged, CLOSE.projectClosed, CLOSE.accessEnded, CLOSE.accessChanged]
    expect(codes).toEqual([4403, 4460, 4461, 4462, 4463, 4464])
    expect(new Set(Object.values(CLOSE)).size).toBe(Object.values(CLOSE).length)
    for (const code of codes) expect(typeof guestCloseText(code, 'Oleg', 'read'), String(code)).toBe('string')
    expect(guestCloseText(CLOSE.kicked, 'Oleg')).toContain('Oleg')
    expect(guestCloseText(1000, 'Oleg')).toBeUndefined()
    expect(INVITE_PATH).toBe('/auth/invite')
  })
})
