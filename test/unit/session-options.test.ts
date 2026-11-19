import { describe, expect, it } from 'vitest'
import { checkSessionEnv, isAppEnvName, MAX_SESSION_ENV, savedSessionEnv, SESSION_ENV } from '../../src/shared/session-options'

const CODE_MODE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'

describe('checkSessionEnv', () => {
  it('accepts no env and an allowed variable with its value', () => {
    expect(checkSessionEnv(undefined)).toEqual({ ok: true })
    const checked = checkSessionEnv({ [CODE_MODE]: '1' })
    expect(checked.ok).toBe(true)
    if (checked.ok) expect({ ...checked.env }).toEqual({ [CODE_MODE]: '1' })
    // An empty object is accepted and applies nothing.
    const empty = checkSessionEnv({})
    expect(empty.ok && Object.keys(empty.env ?? {})).toEqual([])
  })

  it('refuses a wrong value, naming the variable', () => {
    for (const value of ['0', 'true', ' 1', '', 1, true, null, ['1'], { v: '1' }]) {
      const checked = checkSessionEnv({ [CODE_MODE]: value })
      expect(checked).toEqual({ ok: false, reason: expect.stringContaining(CODE_MODE) as unknown })
    }
  })

  it('refuses a name not on the list, naming it', () => {
    for (const name of ['ANTHROPIC_BASE_URL', 'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'HTTPS_PROXY', 'APP_TAB_TOKEN', 'code_mode']) {
      const checked = checkSessionEnv({ [CODE_MODE]: '1', [name]: '1' })
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.reason).toContain(name)
    }
  })

  it('refuses anything but a plain object', () => {
    for (const raw of [null, '1', 1, true, [], [[CODE_MODE, '1']], new Map([[CODE_MODE, '1']]), new (class E {})(), () => 1]) {
      expect(checkSessionEnv(raw).ok).toBe(false)
    }
    // A null-prototype object is plain data too.
    const bare = Object.create(null) as Record<string, string>
    bare[CODE_MODE] = '1'
    expect(checkSessionEnv(bare).ok).toBe(true)
  })

  it('refuses more than the cap, even of allowed-looking keys', () => {
    const many: Record<string, string> = { [CODE_MODE]: '1' }
    for (let i = 0; i < MAX_SESSION_ENV; i++) many[`X${i}`] = '1'
    const checked = checkSessionEnv(many)
    expect(checked).toEqual({ ok: false, reason: `env takes at most ${MAX_SESSION_ENV} variables` })
  })

  it('reads own keys only: no prototype tricks', () => {
    // A `__proto__` key JSON.parse made own (what an RPC delivers) is a name like any other, and refused.
    const parsed = JSON.parse(`{"__proto__": {"PATH": "/evil"}, "${CODE_MODE}": "1"}`) as unknown
    expect(checkSessionEnv(parsed).ok).toBe(false)
    // An inherited key is never read: the object below has no own key, so nothing is applied.
    const inherited = Object.create({ [CODE_MODE]: '1', PATH: '/evil' }) as object
    expect(checkSessionEnv(inherited).ok).toBe(false) // its prototype is not Object.prototype
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const o: Record<string, unknown> = {}
      Object.defineProperty(o, name, { value: '1', enumerable: true })
      expect(checkSessionEnv(o).ok).toBe(false)
    }
    // A symbol key and a getter are refused (never called).
    expect(checkSessionEnv({ [Symbol('x')]: '1' }).ok).toBe(false)
    let called = false
    const getter = {}
    Object.defineProperty(getter, CODE_MODE, {
      enumerable: true,
      get: () => {
        called = true
        return '1'
      }
    })
    expect(checkSessionEnv(getter).ok).toBe(false)
    expect(called).toBe(false)
    // A non-enumerable own key still counts (Reflect.ownKeys), so it cannot hide from the check.
    const hidden: Record<string, unknown> = { [CODE_MODE]: '1' }
    Object.defineProperty(hidden, 'PATH', { value: '/evil', enumerable: false })
    expect(checkSessionEnv(hidden).ok).toBe(false)
  })

  it('answers a null-prototype copy, not the caller object', () => {
    const raw = { [CODE_MODE]: '1' }
    const checked = checkSessionEnv(raw)
    expect(checked.ok && checked.env !== raw).toBe(true)
    expect(checked.ok && Object.getPrototypeOf(checked.env)).toBe(null)
  })
})

describe('savedSessionEnv', () => {
  it('keeps the entries still allowed and names the dropped ones', () => {
    expect(savedSessionEnv(undefined)).toEqual({ dropped: [] })
    const read = savedSessionEnv({ [CODE_MODE]: '1', PATH: '/evil', OLD_FLAG: '1' })
    expect({ ...read.env }).toEqual({ [CODE_MODE]: '1' })
    expect(read.dropped).toEqual(['PATH', 'OLD_FLAG'])
  })

  it('drops a wrong value and leaves no env when nothing is left', () => {
    expect(savedSessionEnv({ [CODE_MODE]: '0' })).toEqual({ dropped: [CODE_MODE] })
    expect(savedSessionEnv('x')).toEqual({ dropped: ['(not an object)'] })
    expect(savedSessionEnv([CODE_MODE])).toEqual({ dropped: ['(not an object)'] })
    const parsed = JSON.parse('{"__proto__": {"PATH": "/evil"}}') as unknown
    expect(savedSessionEnv(parsed)).toEqual({ dropped: ['__proto__'] })
  })
})

describe('SESSION_ENV', () => {
  it('names none of the app variables, and cannot be changed at run time', () => {
    for (const name of Object.keys(SESSION_ENV)) expect(isAppEnvName(name)).toBe(false)
    for (const name of ['APP_TAB_ID', 'APP_TAB_TOKEN', 'CC_COCKPIT_SOCK', 'CC_COCKPIT_ANYTHING', 'PATH', 'TERM', 'ELECTRON_RUN_AS_NODE']) {
      expect(isAppEnvName(name)).toBe(true)
    }
    expect(Object.isFrozen(SESSION_ENV)).toBe(true)
    expect(Object.isFrozen(SESSION_ENV[CODE_MODE]!.values)).toBe(true)
  })
})
