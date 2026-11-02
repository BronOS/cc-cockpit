import { describe, expect, it } from 'vitest'
import { isTestRun } from '../../src/main/test-run'

describe('isTestRun', () => {
  it('is on only for CC_COCKPIT_TEST=1 in an unpackaged app', () => {
    expect(isTestRun({ CC_COCKPIT_TEST: '1' }, false)).toBe(true)
  })

  it('a packaged app never is, whatever its environment says', () => {
    expect(isTestRun({ CC_COCKPIT_TEST: '1' }, true)).toBe(false)
    expect(isTestRun({ CC_COCKPIT_TEST: '1', CC_COCKPIT_FAKE_SECRETS: '1' }, true)).toBe(false)
  })

  it('needs exactly "1"', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(isTestRun({ CC_COCKPIT_TEST: value }, false), String(value)).toBe(false)
    }
  })
})
