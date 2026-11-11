import { describe, expect, it } from 'vitest'
import {
  HOST_ONLY_COMMANDS,
  LineFramer,
  PROJECTLESS_COMMANDS,
  TOKENLESS_COMMANDS,
  WINDOW_TOKEN_COMMANDS,
  LineTooLongError,
  MAX_LINE_BYTES,
  ProtocolError,
  encodeReply,
  encodeRequest,
  parseReply,
  parseRequest
} from '../../src/shared/protocol'

describe('parseRequest', () => {
  it('round-trips an encoded request', () => {
    const line = encodeRequest({ v: 1, id: 7, token: 'ab', project: '/p', cmd: 'hook', args: { a: 1 } })
    expect(line.endsWith('\n')).toBe(true)
    expect(parseRequest(line.trimEnd())).toEqual({
      v: 1,
      id: 7,
      token: 'ab',
      project: '/p',
      cmd: 'hook',
      args: { a: 1 }
    })
  })

  it('defaults args to an empty object', () => {
    expect(parseRequest('{"v":1,"id":1,"cmd":"x"}').args).toEqual({})
  })

  it('refuses prototype-reaching keys at the top level of args', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const err = catchError(() => parseRequest(`{"v":1,"id":3,"cmd":"x","args":{"${key}":{"x":1}}}`))
      expect(err).toBeInstanceOf(ProtocolError)
      expect((err as ProtocolError).id).toBe(3)
      expect((err as Error).message).toContain(key)
    }
    // Nested ones are data (a hook payload may quote anything); the Handler contract covers them.
    expect(parseRequest('{"v":1,"id":3,"cmd":"x","args":{"p":{"constructor":1}}}').args).toEqual({
      p: { constructor: 1 }
    })
  })

  it('rejects bad json and non-objects without an id', () => {
    for (const line of ['{', '[]', '"x"', 'null']) {
      const err = catchError(() => parseRequest(line))
      expect(err).toBeInstanceOf(ProtocolError)
      expect((err as ProtocolError).id).toBeNull()
    }
  })

  it('keeps the id on errors found after the id was read', () => {
    const cases = [
      '{"v":2,"id":3,"cmd":"x"}',
      '{"v":1,"id":3}',
      '{"v":1,"id":3,"cmd":""}',
      '{"v":1,"id":3,"cmd":"x","token":5}',
      '{"v":1,"id":3,"cmd":"x","project":[]}',
      '{"v":1,"id":3,"cmd":"x","args":[1]}'
    ]
    for (const line of cases) expect((catchError(() => parseRequest(line)) as ProtocolError).id).toBe(3)
  })

  it('requires an integer id', () => {
    for (const id of ['1.5', '"1"', 'null']) {
      expect((catchError(() => parseRequest(`{"v":1,"id":${id},"cmd":"x"}`)) as ProtocolError).message).toMatch(
        /id/
      )
    }
  })
})

describe('parseReply', () => {
  it('reads ok and error replies', () => {
    expect(parseReply(encodeReply({ id: 1, ok: true, result: { a: 1 } }))).toEqual({ id: 1, ok: true, result: { a: 1 } })
    expect(parseReply(encodeReply({ id: null, ok: false, error: 'no' }))).toEqual({ id: null, ok: false, error: 'no' })
  })

  it('keeps a string appVersion on ok and error replies, and drops any other type', () => {
    expect(parseReply('{"id":1,"ok":true,"result":null,"appVersion":"1.2.3"}')).toEqual({ id: 1, ok: true, result: null, appVersion: '1.2.3' })
    expect(parseReply('{"id":1,"ok":false,"error":"no","appVersion":"1.2.3"}')).toEqual({ id: 1, ok: false, error: 'no', appVersion: '1.2.3' })
    expect(parseReply('{"id":1,"ok":true,"result":null,"appVersion":7}')).toEqual({ id: 1, ok: true, result: null })
  })

  it('throws on a malformed reply', () => {
    expect(() => parseReply('{"id":1}')).toThrow()
    expect(() => parseReply('{"id":"x","ok":true}')).toThrow()
    expect(() => parseReply('{"id":1,"ok":false}')).toThrow()
  })
})

describe('LineFramer', () => {
  it('splits lines across chunk boundaries, including inside a multi-byte character', () => {
    const framer = new LineFramer()
    const bytes = Buffer.from('héllo\nwörld\n')
    const out: string[] = []
    // One byte at a time: every UTF-8 sequence gets split somewhere.
    for (const b of bytes) out.push(...framer.push(Buffer.from([b])))
    expect(out).toEqual(['héllo', 'wörld'])
  })

  it('returns several lines from one chunk and keeps the tail', () => {
    const framer = new LineFramer()
    expect(framer.push(Buffer.from('a\nb\nc'))).toEqual(['a', 'b'])
    expect(framer.push(Buffer.from('d\n'))).toEqual(['cd'])
  })

  it('accepts a line exactly at the cap and refuses one byte more', () => {
    expect(new LineFramer(4).push(Buffer.from('abcd\n'))).toEqual(['abcd'])
    expect(() => new LineFramer(4).push(Buffer.from('abcde\n'))).toThrow(LineTooLongError)
  })

  it('refuses an unterminated tail as soon as it passes the cap', () => {
    const framer = new LineFramer(4)
    framer.push(Buffer.from('abc'))
    expect(() => framer.push(Buffer.from('de'))).toThrow(LineTooLongError)
  })

  it('defaults to a 1 MiB cap', () => {
    expect(MAX_LINE_BYTES).toBe(1024 * 1024)
    const framer = new LineFramer()
    expect(() => framer.push(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61))).toThrow(LineTooLongError)
  })
})

function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('HOST_ONLY_COMMANDS (ccc web, design-web.md §9.4)', () => {
  it('lists all eight ccc web requests, those whose handler comes later included', () => {
    expect([...HOST_ONLY_COMMANDS].sort()).toEqual(
      ['web.status', 'web.revoke', 'web.stop', 'web.link', 'web.add-device', 'web.password', 'web.mode', 'web.set'].sort()
    )
  })

  it('is kept out of every list a tab token or a --project caller is let through by', () => {
    for (const cmd of HOST_ONLY_COMMANDS) {
      expect(TOKENLESS_COMMANDS, cmd).not.toContain(cmd)
      expect(PROJECTLESS_COMMANDS, cmd).not.toContain(cmd)
      expect(WINDOW_TOKEN_COMMANDS, cmd).not.toContain(cmd)
    }
  })
})
