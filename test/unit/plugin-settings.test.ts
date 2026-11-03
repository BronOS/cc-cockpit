import { beforeAll, describe, expect, it } from 'vitest'
import { checkPluginSettings, compileSettingsSchema, MAX_SCHEMA_EXPANSION, validateSettings } from '../../src/main/plugins/validate'
import type { PluginManifest } from '../../src/shared/manifest'

const schema = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', default: 'https://example.com' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    nested: { type: 'object', default: {}, properties: { flag: { type: 'boolean', default: true } } }
  },
  required: ['baseUrl']
}

function manifestWith(settings: { project?: Record<string, unknown>; app?: Record<string, unknown> }): PluginManifest {
  return { id: 'a.b', name: 'X', version: '1.0.0', api: 1, contributes: { settings } }
}

describe('validateSettings', () => {
  it('applies defaults to an empty or missing value', () => {
    for (const stored of [undefined, null, {}]) {
      expect(validateSettings(schema, stored)).toEqual({
        ok: true,
        value: { baseUrl: 'https://example.com', limit: 20, nested: { flag: true } }
      })
    }
  })

  it('keeps stored values over defaults and does not mutate the input', () => {
    const stored = { limit: 5 }
    const r = validateSettings(schema, stored)
    expect(r).toEqual({ ok: true, value: { baseUrl: 'https://example.com', limit: 5, nested: { flag: true } } })
    expect(stored).toEqual({ limit: 5 })
  })

  it('reports each violation with its location', () => {
    const r = validateSettings(schema, { limit: 500, baseUrl: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toContain('/limit must be <= 100')
      expect(r.errors).toContain('/baseUrl must be string')
    }
  })

  it('refuses a stored value that is not an object', () => {
    for (const v of ['x', 3, [], true]) expect(validateSettings(schema, v)).toEqual({ ok: false, errors: ['settings must be an object'] })
  })

  it('treats a plugin without that scope as having no settings', () => {
    expect(validateSettings(undefined, { junk: 1 })).toEqual({ ok: true, value: {} })
  })

  it('does not coerce types', () => {
    expect(validateSettings(schema, { limit: '5' }).ok).toBe(false)
  })

  it('accepts form-library hints ajv does not know', () => {
    const s = { type: 'object', title: 'T', 'ui:order': ['a'], properties: { a: { type: 'string', format: 'uri', title: 'A' } } }
    expect(validateSettings(s, { a: 'not checked as uri' }).ok).toBe(true)
  })

  it('supports local $ref', () => {
    const s = {
      type: 'object',
      definitions: { n: { type: 'integer' } },
      properties: { a: { $ref: '#/definitions/n' } }
    }
    expect(validateSettings(s, { a: 3 })).toEqual({ ok: true, value: { a: 3 } })
    expect(validateSettings(s, { a: 'x' }).ok).toBe(false)
  })
})

describe('compileSettingsSchema', () => {
  function errorsOf(s: unknown): string[] {
    const r = compileSettingsSchema(s)
    if (r.ok) throw new Error('expected a compile failure')
    return r.errors
  }

  it('refuses schemas that are not objects or not of type object', () => {
    expect(errorsOf('x')).toEqual(['schema must be an object'])
    expect(errorsOf([])).toEqual(['schema must be an object'])
    expect(errorsOf({ properties: {} })).toEqual(['the root schema must have "type": "object"'])
    expect(errorsOf({ type: 'string' })).toEqual(['the root schema must have "type": "object"'])
  })

  it('fails the meta-schema check instead of throwing', () => {
    expect(errorsOf({ type: 'object', properties: { a: { type: 'nope' } } })[0]).toContain('invalid settings schema')
    expect(errorsOf({ type: 'object', minimum: 'x' })[0]).toContain('invalid settings schema')
  })

  it('refuses remote and unresolvable refs without fetching', () => {
    expect(errorsOf({ type: 'object', properties: { a: { $ref: 'https://evil.example/schema.json' } } })[0]).toContain(
      'only local'
    )
    expect(errorsOf({ type: 'object', properties: { a: { $ref: '#/definitions/missing' } } })[0]).toContain('invalid settings schema')
  })

  it('refuses $id and $schema', () => {
    expect(errorsOf({ type: 'object', $id: 'http://x/y' })[0]).toContain('"$id" is not allowed')
    expect(errorsOf({ type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' })[0]).toContain('"$schema" is not allowed')
  })

  it('does not treat a property named $id as the keyword', () => {
    const s = { type: 'object', properties: { $id: { type: 'string' } } }
    expect(compileSettingsSchema(s).ok).toBe(true)
  })

  it('takes "format": "multiline" as a form hint anywhere, checking only the string', () => {
    // The settings form draws it as a textarea (plugin-form-templates.tsx); main's ajv has
    // validateFormats off, so the unknown format neither fails the compile nor the values.
    const s = {
      type: 'object',
      properties: {
        profile: { type: 'string', format: 'multiline', maxLength: 20, default: '' },
        rules: { type: 'array', items: { type: 'object', properties: { note: { type: 'string', format: 'multiline' } } } },
        criteria: { type: 'object', properties: { urgent: { type: 'string', format: 'multiline' } } }
      }
    }
    expect(compileSettingsSchema(s).ok).toBe(true)
    const value = { profile: 'two\nlines', rules: [{ note: 'a\nb' }], criteria: { urgent: 'x\ny' } }
    expect(validateSettings(s, value)).toEqual({ ok: true, value })
    expect(validateSettings(s, { profile: 'x'.repeat(21) }).ok).toBe(false)
    expect(validateSettings(s, { profile: 5 }).ok).toBe(false)
  })

  it('checks a "format": "sound" field: a plain string with "" or a built-in default, anywhere', () => {
    const ok = {
      type: 'object',
      properties: {
        reminder: { type: 'string', format: 'sound', title: 'Reminder sound', description: 'd', default: '', $comment: 'c' },
        alarm: { type: 'string', format: 'sound', default: 'builtin:bell' },
        bare: { type: 'string', format: 'sound' },
        perCalendar: { type: 'array', items: { type: 'object', properties: { sound: { type: 'string', format: 'sound' } } } }
      }
    }
    expect(compileSettingsSchema(ok).ok).toBe(true)
    // Not checked against the app's sounds: main does that when the plugin passes it to ctx.notify.
    const value = { reminder: 'system:0:x/y.oga', perCalendar: [{ sound: 'anything' }] }
    expect(validateSettings(ok, value).ok).toBe(true)
    const field = (f: Record<string, unknown>): object => ({ type: 'object', properties: { s: { format: 'sound', ...f } } })
    expect(errorsOf(field({ type: 'integer' }))[0]).toBe('/properties/s: a "format": "sound" field must have "type": "string"')
    expect(errorsOf(field({}))[0]).toContain('must have "type": "string"')
    expect(errorsOf(field({ type: ['string', 'null'] }))[0]).toContain('must have "type": "string"')
    // A system file differs per machine; an unknown built-in or another type is no sound.
    for (const bad of ['system:0:freedesktop/stereo/bell.oga', 'builtin:kazoo', 'chime', null]) {
      expect(errorsOf(field({ type: 'string', default: bad }))[0]).toContain(`"default" is "" (the app's sound) or a built-in id`)
    }
    for (const key of ['enum', 'maxLength', 'const', 'examples', 'oneOf']) {
      const extra = key === 'oneOf' ? [{ const: 'builtin:bell' }] : key === 'maxLength' ? 10 : ['builtin:bell']
      expect(errorsOf(field({ type: 'string', [key]: extra })).join()).toContain(`not "${key}"`)
    }
    // Nested: the same rules in `items` and a nested object.
    expect(errorsOf({ type: 'object', properties: { a: { type: 'array', items: { type: 'number', format: 'sound' } } } })[0]).toBe(
      '/properties/a/items: a "format": "sound" field must have "type": "string"'
    )
    // "sound" as data (a default, an enum value) or as a property name is no format keyword.
    expect(compileSettingsSchema({ type: 'object', properties: { format: { type: 'string', enum: ['sound'] } } }).ok).toBe(true)
    expect(compileSettingsSchema({ type: 'object', properties: { a: { type: 'object', default: { format: 'sound' } } } }).ok).toBe(true)
  })

  it('does not honour $data', () => {
    const s = { type: 'object', properties: { a: { type: 'integer' }, b: { minimum: { $data: '1/a' } } } }
    // With $data off ajv rejects the non-numeric minimum at meta-schema time rather than resolving it.
    expect(compileSettingsSchema(s).ok).toBe(false)
  })

  it('caps size and depth', () => {
    expect(errorsOf({ type: 'object', description: 'x'.repeat(70 * 1024) })[0]).toContain('larger than')
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { a: deep } }
    expect(errorsOf(deep).join()).toContain('nested deeper')
  })

  it('caps minItems, which the settings form would fill and render entry by entry', () => {
    const hang = { type: 'object', properties: { a: { type: 'array', minItems: 100_000_000, items: { type: 'string', default: 'x' } } } }
    expect(errorsOf(hang)[0]).toContain('"minItems" above 100')
    const fine = { type: 'object', properties: { a: { type: 'array', minItems: 2, items: { type: 'string' } } } }
    expect(compileSettingsSchema(fine).ok).toBe(true)
    // A property named minItems is not the keyword.
    expect(compileSettingsSchema({ type: 'object', properties: { minItems: { type: 'string' } } }).ok).toBe(true)
  })

  describe('default expansion budget', () => {
    const arr = (minItems: number, items: unknown): Record<string, unknown> => ({ type: 'array', minItems, items })
    const leaf = { type: 'string', default: 'x' }
    // The settings form's validator (PluginSettingsForm.tsx noRendererValidation), which checks nothing.
    const noRendererValidation = {
      validateFormData: () => ({ errors: [], errorSchema: {} }),
      isValid: () => true,
      rawValidation: () => ({ errors: [] })
    }
    // rjsf is a renderer dependency: a static import would pull React's DOM stubs into this node
    // program's types (and break Playwright's element types in test/e2e), so it is loaded by a
    // specifier TypeScript does not resolve, typed by hand.
    const RJSF_UTILS = '@rjsf/utils'
    type DefaultFormState = (validator: unknown, schema: unknown, formData: unknown, root: unknown) => unknown
    let getDefaultFormState: DefaultFormState
    beforeAll(async () => {
      getDefaultFormState = ((await import(/* @vite-ignore */ RJSF_UTILS)) as { getDefaultFormState: DefaultFormState }).getDefaultFormState
    })
    /** Values in what rjsf's form would start from (it fills arrays up to minItems). */
    const formValues = (s: Record<string, unknown>): number => {
      const count = (x: unknown): number =>
        typeof x === 'object' && x !== null ? 1 + Object.values(x).reduce<number>((n, v) => n + count(v), 0) : 1
      return count(getDefaultFormState(noRendererValidation, s, undefined, s))
    }

    it('refuses nested minItems whose product the per-array cap does not see', () => {
      // The reviewer's case: 188 bytes, three arrays of 50 deep, 125,000 entries.
      const nested = { type: 'object', properties: { a: arr(50, arr(50, arr(50, leaf))) } }
      expect(JSON.stringify(nested).length).toBeLessThan(200)
      expect(formValues(nested)).toBeGreaterThan(100_000)
      expect(errorsOf(nested)[0]).toContain(`more than ${MAX_SCHEMA_EXPANSION} values`)
      // Without defaults too: rjsf fills the entries with null all the same.
      expect(errorsOf({ type: 'object', properties: { a: arr(50, arr(50, arr(50, { type: 'string' }))) } })[0]).toContain(
        'more than'
      )
    })

    it('follows $refs, so splitting the nesting across definitions does not hide it', () => {
      const viaRef = {
        type: 'object',
        definitions: { b: arr(50, { $ref: '#/definitions/c' }), c: arr(50, leaf) },
        properties: { a: arr(50, { $ref: '#/definitions/b' }) }
      }
      expect(errorsOf(viaRef)[0]).toContain('more than')
    })

    it('counts minItems across anyOf/oneOf options, which the form merges with the array holding them', () => {
      // The reviewer's case: `minItems` on the array, `items` in an anyOf option, three deep.
      const minOutside = (inner: unknown, k: 'anyOf' | 'oneOf'): Record<string, unknown> => ({
        type: 'array',
        minItems: 50,
        [k]: [{ items: inner }]
      })
      // The reverse: `items` on the array, `minItems` in the option.
      const minInside = (inner: unknown): Record<string, unknown> => ({ type: 'array', items: inner, anyOf: [{ minItems: 50 }] })
      const cases = [
        { type: 'object', properties: { a: minOutside(minOutside(minOutside(leaf, 'anyOf'), 'anyOf'), 'anyOf') } },
        { type: 'object', properties: { a: minOutside(minOutside(minOutside(leaf, 'oneOf'), 'oneOf'), 'oneOf') } },
        { type: 'object', properties: { a: minInside(minInside(minInside(leaf))) } }
      ]
      for (const s of cases) {
        expect(JSON.stringify(s).length, JSON.stringify(s)).toBeLessThan(240)
        // The form really builds them: this is what the bound has to cover.
        expect(formValues(s)).toBeGreaterThan(100_000)
        expect(errorsOf(s)[0], JSON.stringify(s)).toContain(`more than ${MAX_SCHEMA_EXPANSION} values`)
      }
    })

    it('counts minItems carried into a $ref target and through allOf, if/then/else and dependentSchemas', () => {
      // `minItems` beside the ref, `items` in its target (the form merges a ref with its siblings).
      const viaRef = {
        type: 'object',
        definitions: { x: { items: { $ref: '#/definitions/y' } }, y: { type: 'array', minItems: 50, $ref: '#/definitions/z' }, z: { items: arr(50, leaf) } },
        properties: { a: { type: 'array', minItems: 50, $ref: '#/definitions/x' } }
      }
      expect(errorsOf(viaRef)[0]).toContain('more than')
      const wrap = (k: string, inner: unknown): Record<string, unknown> => {
        if (k === 'allOf') return { type: 'array', minItems: 50, allOf: [{ items: inner }] }
        if (k === 'then') return { type: 'array', minItems: 50, if: { type: 'array' }, then: { items: inner } }
        return { type: 'array', minItems: 50, dependentSchemas: { x: { items: inner } } }
      }
      for (const k of ['allOf', 'then', 'dependentSchemas']) {
        const s = { type: 'object', properties: { a: wrap(k, wrap(k, wrap(k, leaf))) } }
        expect(errorsOf(s)[0], k).toContain('more than')
      }
    })

    it('accepts ordinary anyOf/oneOf use under the budget', () => {
      const accepted = [
        // A nullable leaf in a modest array.
        { type: 'object', properties: { a: arr(10, { anyOf: [leaf, { type: 'null' }] }) } },
        // Options with their own small arrays.
        {
          type: 'object',
          properties: {
            target: {
              oneOf: [
                { type: 'object', properties: { hosts: arr(5, leaf) } },
                { type: 'object', properties: { ports: arr(5, { type: 'integer', default: 80 }) } }
              ]
            }
          }
        },
        // minItems in one option, items beside it: the group's largest minItems, still small.
        { type: 'object', properties: { a: { type: 'array', items: arr(3, leaf), anyOf: [{ minItems: 4 }, { maxItems: 0 }] } } }
      ]
      for (const s of accepted) {
        expect(compileSettingsSchema(s).ok, JSON.stringify(s)).toBe(true)
        expect(formValues(s)).toBeLessThanOrEqual(MAX_SCHEMA_EXPANSION)
        expect(validateSettings(s, {}).ok).toBe(true)
      }
    })

    it('refuses a $ref fan-out that ajv would expand exponentially in main on every check', () => {
      // No arrays at all: each definition uses the next one twice, 2^n objects from a 2 KB schema.
      const defs: Record<string, unknown> = {}
      const n = 20
      for (let i = 0; i < n; i++) {
        const next = i + 1 < n ? { $ref: `#/definitions/d${i + 1}`, default: {} } : leaf
        defs[`d${i}`] = { type: 'object', properties: { x: next, y: next } }
      }
      const fan = { type: 'object', definitions: defs, properties: { a: { $ref: '#/definitions/d0', default: {} } } }
      const t0 = performance.now()
      expect(errorsOf(fan)[0]).toContain('more than')
      expect(performance.now() - t0).toBeLessThan(1000)
    })

    it('refuses $ref chains deeper than the walk follows', () => {
      const defs: Record<string, unknown> = {}
      for (let i = 0; i < 40; i++) defs[`d${i}`] = i < 39 ? { $ref: `#/definitions/d${i + 1}` } : { type: 'string' }
      expect(errorsOf({ type: 'object', definitions: defs, properties: { a: { $ref: '#/definitions/d0' } } })[0]).toContain(
        '"$ref"s nest more than'
      )
    })

    it('accepts ordinary arrays, shared definitions and a recursive tree, each under the budget in the form', () => {
      const accepted = [
        { type: 'object', properties: { a: arr(100, { type: 'object', properties: { b: leaf, c: { type: 'integer', default: 1 } } }) } },
        { type: 'object', properties: { a: arr(10, arr(10, leaf)), b: arr(10, leaf) } },
        {
          type: 'object',
          definitions: { host: { type: 'object', properties: { name: leaf, port: { type: 'integer', default: 80 } } } },
          properties: { primary: { $ref: '#/definitions/host' }, backups: arr(3, { $ref: '#/definitions/host' }) }
        },
        {
          type: 'object',
          definitions: { node: { type: 'object', properties: { label: leaf, children: arr(3, { $ref: '#/definitions/node' }) } } },
          properties: { root: { $ref: '#/definitions/node' } }
        }
      ]
      for (const s of accepted) {
        expect(compileSettingsSchema(s).ok, JSON.stringify(s)).toBe(true)
        expect(formValues(s)).toBeLessThanOrEqual(MAX_SCHEMA_EXPANSION)
        expect(validateSettings(s, {}).ok).toBe(true)
      }
    })
  })

  it('refuses regexes, which could backtrack catastrophically in main', () => {
    // `^(a+)+$` is short; with a matching-prefix default it would hang main on every check.
    const redos = { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$', default: 'a'.repeat(40) + '!' } } }
    expect(errorsOf(redos)[0]).toContain('regular expressions')
    const props = { type: 'object', patternProperties: { '^(a+)+$': { type: 'string' } }, additionalProperties: false }
    expect(errorsOf(props)[0]).toContain('regular expressions')
    expect(compileSettingsSchema({ type: 'object', properties: { pattern: { type: 'string' } } }).ok).toBe(true)
  })

  it('refuses $async, whose validator would return a truthy Promise', () => {
    expect(errorsOf({ $async: true, type: 'object', properties: { a: { type: 'integer' } } })[0]).toContain('"$async" is not allowed')
    expect(compileSettingsSchema({ type: 'object', properties: { $async: { type: 'boolean' } } }).ok).toBe(true)
  })

  it('refuses prototype keys in properties, defaults and required', () => {
    // JSON.parse makes `__proto__` an own key, as it would be in plugin.json; a TS literal would not.
    const inDefault = JSON.parse('{"type":"object","properties":{"o":{"type":"object","default":{"__proto__":{"isAdmin":true}}}}}')
    expect(errorsOf(inDefault)[0]).toContain('"__proto__" is not allowed')
    expect(errorsOf({ type: 'object', properties: { constructor: { type: 'string' } } })[0]).toContain('"constructor" is not allowed')
  })

  it('caches by schema object', () => {
    const s = { type: 'object' }
    expect(compileSettingsSchema(s)).toBe(compileSettingsSchema(s))
  })
})

describe('validateSettings with hostile schemas and values', () => {
  it('a required name only Object.prototype has is still missing', () => {
    const r = validateSettings({ type: 'object', required: ['constructor', 'toString'] }, {})
    expect(r.ok).toBe(false)
  })

  it('refuses prototype keys in a stored value', () => {
    const s = { type: 'object' }
    expect(validateSettings(s, JSON.parse('{"a":{"__proto__":{"isAdmin":true}}}'))).toEqual({
      ok: false,
      errors: ['/a/__proto__ is not allowed as a key']
    })
    expect(validateSettings(s, { prototype: 1 })).toEqual({ ok: false, errors: ['/prototype is not allowed as a key'] })
  })

  it('turns a validator that throws into a reason (recursive $ref with defaults)', () => {
    const recursive = {
      type: 'object',
      definitions: { n: { type: 'object', properties: { a: { $ref: '#/definitions/n', default: {} } } } },
      properties: { a: { $ref: '#/definitions/n', default: {} } }
    }
    expect(compileSettingsSchema(recursive).ok).toBe(true)
    const r = checkPluginSettings(manifestWith({ app: recursive }), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('invalid app settings: settings cannot be validated')
  })
})

describe('checkPluginSettings', () => {
  const manifest = manifestWith({
    app: { type: 'object', properties: { baseUrl: { type: 'string', default: 'https://a' } } },
    project: { type: 'object', properties: { board: { type: 'string', default: 'main' } }, required: ['team'] }
  })

  it('returns both scopes with defaults applied', () => {
    expect(checkPluginSettings(manifest, { project: { team: 'x' } })).toEqual({
      ok: true,
      app: { baseUrl: 'https://a' },
      project: { board: 'main', team: 'x' }
    })
  })

  it('fails with a reason that names the scope', () => {
    expect(checkPluginSettings(manifest, {})).toEqual({
      ok: false,
      reason: "invalid project settings: / must have required property 'team'"
    })
    const r = checkPluginSettings(manifest, { app: { baseUrl: 3 }, project: { team: 'x' } })
    expect(r).toEqual({ ok: false, reason: 'invalid app settings: /baseUrl must be string' })
  })

  it('a plugin with no settings gets empty objects', () => {
    expect(checkPluginSettings({ id: 'a.b', name: 'X', version: '1.0.0', api: 1 }, {})).toEqual({ ok: true, app: {}, project: {} })
  })

  it('a schema that cannot compile disables with its reason', () => {
    const bad = manifestWith({ app: { type: 'object', $id: 'x' } })
    const r = checkPluginSettings(bad, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('"$id" is not allowed')
  })
})
