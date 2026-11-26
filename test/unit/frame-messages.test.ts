import { describe, expect, it } from 'vitest'
import {
  droppedEnvelope,
  isPageEnvelope,
  overlayMessageOf,
  overlayResultOf,
  pageEnvelopeOf,
  textHasEnvelopeKey
} from '../../src/renderer/plugins/frame-messages'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../src/shared/overlay-message'

// Task 04 (spec-review S1, S12): how the shell reads a page's `$cc` envelope, and what it never relays.

describe('a page message with a top-level $cc', () => {
  it('overlayMessageOf refuses a top-level $cc', () => {
    expect(overlayMessageOf('{"$cc":1,"id":1,"op":"notes.list","args":{}}')).toBeUndefined()
    // Any value of the key counts: it is reserved, not only version 1.
    expect(overlayMessageOf('{"$cc":"x"}')).toBeUndefined()
    // Nested or as a value it is the plugin's own text.
    expect(overlayMessageOf('{"a":{"$cc":1}}')).toBe('{"a":{"$cc":1}}')
    expect(overlayMessageOf('"$cc"')).toBe('"$cc"')
  })

  it('is never an overlay result, even with a result beside it', () => {
    expect(overlayResultOf('{"$cc":1,"result":1}')).toBeUndefined()
    expect(overlayResultOf('{"result":1}')).toEqual({ value: 1 })
  })

  it('reads a request: id, op and args; a problem with the id when that much is readable', () => {
    const ok = pageEnvelopeOf('{"$cc":1,"id":4,"op":"notes.add","args":{"text":"t"}}')
    expect(ok && isPageEnvelope(ok) ? ok : undefined).toEqual({ id: 4, op: 'notes.add', args: { text: 't' } })
    // args may be left out (an op with none).
    expect(pageEnvelopeOf('{"$cc":1,"id":0,"op":"ask.close"}')).toEqual({ id: 0, op: 'ask.close', args: {} })
    expect(pageEnvelopeOf('{"$cc":1,"id":5,"op":"tabs.close","args":{}}')).toEqual({ problem: 'unknown op', id: 5 })
    expect(pageEnvelopeOf('{"$cc":2,"id":5,"op":"notes.list"}')).toEqual({ problem: 'unknown envelope version', id: 5 })
    expect(pageEnvelopeOf('{"$cc":1,"id":5,"op":"notes.list","args":[1]}')).toEqual({ problem: 'args must be an object', id: 5 })
    // An answer or a push coming up from the page: no op, refused.
    expect(pageEnvelopeOf('{"$cc":1,"re":5,"ok":true,"value":1}')).toEqual({ problem: 'no request id' })
    expect(pageEnvelopeOf('{"$cc":1,"id":-1,"op":"notes.list"}')).toEqual({ problem: 'no request id' })
    expect(pageEnvelopeOf('{"$cc":1,"id":1.5,"op":"notes.list"}')).toEqual({ problem: 'no request id' })
    // Not an envelope at all: the old paths.
    expect(pageEnvelopeOf('{"result":1}')).toBeUndefined()
    expect(pageEnvelopeOf({ $cc: 1, id: 1, op: 'notes.list' })).toBeUndefined()
  })

  it('fail closed: an unparsable or oversized envelope is no request (and no plain message either)', () => {
    const junk = '{"$cc":1,"id":1,'
    expect(pageEnvelopeOf(junk)).toBeUndefined()
    expect(overlayMessageOf(junk)).toBeUndefined()
    const big = `{"$cc":1,"id":1,"op":"notes.add","args":{"text":"${'x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH)}"}}`
    expect(pageEnvelopeOf(big)).toBeUndefined()
    expect(overlayMessageOf(big)).toBeUndefined()
  })

  it('textHasEnvelopeKey reads only a top-level object key', () => {
    expect(textHasEnvelopeKey('{"$cc":1}')).toBe(true)
    // A key spelled with a JSON escape is the same key.
    expect(textHasEnvelopeKey('  \n{"\\u0024cc":1}')).toBe(true)
    expect(textHasEnvelopeKey('{"a":{"$cc":1}}')).toBe(false)
    expect(textHasEnvelopeKey('["$cc"]')).toBe(false)
    expect(textHasEnvelopeKey('{"$cc":1')).toBe(false)
  })
})

describe('pages with no copy port', () => {
  it('`$cc` from a non-perView or inline overlay is dropped with a log line', () => {
    const logs: string[] = []
    const log = (m: string): number => logs.push(m)
    // A non-perView plugin page posts JSON texts; an inline page posts objects.
    expect(droppedEnvelope('{"$cc":1,"id":1,"op":"discuss.open","args":{}}', log)).toBe(true)
    expect(droppedEnvelope({ $cc: 1, id: 1, op: 'notes.list' }, log)).toBe(true)
    // main's mark on an event for such an overlay: dropped too.
    expect(droppedEnvelope('"text"', log, true)).toBe(true)
    expect(logs).toHaveLength(3)
    expect(logs[0]).toMatch(/envelope dropped/)
    // Anything else goes on as before, unlogged.
    expect(droppedEnvelope('{"result":1}', log)).toBe(false)
    expect(droppedEnvelope({ type: 'ready' }, log)).toBe(false)
    expect(logs).toHaveLength(3)
  })

  it('fail closed: an unparsable envelope too', () => {
    const logs: string[] = []
    // Not JSON: no envelope to route, and overlayMessageOf drops it as junk (its own log line in HtmlOverlay).
    expect(droppedEnvelope('{"$cc":1,', (m) => logs.push(m))).toBe(false)
    expect(overlayMessageOf('{"$cc":1,')).toBeUndefined()
    expect(overlayResultOf('{"$cc":1,')).toBeUndefined()
  })
})
