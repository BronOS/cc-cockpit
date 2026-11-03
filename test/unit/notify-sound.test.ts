// The notification sound: the id rules (shared/notify-sound.ts), the built-in tone presets
// (renderer/notify/tones.ts), the player's fallback to the Chime (renderer/notify/sound-player.ts)
// and the AIFF reader (renderer/notify/aiff.ts), all under Node with a recording fake context.
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SOUNDS,
  DEFAULT_NOTIFY_SOUND,
  notificationSoundOf,
  parseSoundId,
  soundMediaType
} from '../../src/shared/notify-sound'
import { decodeAiff, isAiff } from '../../src/renderer/notify/aiff'
import { createSoundPlayer, type PlayBuffer, type PlayContext } from '../../src/renderer/notify/sound-player'
import { scheduleTone, toneDuration, TONES, type ToneParam } from '../../src/renderer/notify/tones'

describe('sound ids', () => {
  it('parses built-ins and system ids, and refuses anything that could be a path trick', () => {
    expect(parseSoundId('builtin:chime')).toEqual({ kind: 'builtin', name: 'chime' })
    expect(parseSoundId('system:0:freedesktop/stereo/bell.oga')).toEqual({ kind: 'system', root: 0, rel: 'freedesktop/stereo/bell.oga' })
    expect(parseSoundId('system:12:a b.wav')).toEqual({ kind: 'system', root: 12, rel: 'a b.wav' })
    for (const bad of [
      'builtin:siren',
      'builtin:',
      'chime',
      'system:0:',
      'system::a.wav',
      'system:123:a.wav',
      'system:-1:a.wav',
      'system:0:/etc/passwd',
      'system:0:../a.wav',
      'system:0:a/../../b.wav',
      'system:0:./a.wav',
      'system:0:a//b.wav',
      'system:0:a\\..\\b.wav',
      'system:0:a\nb.wav',
      `system:0:${'a'.repeat(2000)}.wav`,
      '/usr/share/sounds/a.wav',
      42,
      null,
      undefined
    ]) {
      expect(parseSoundId(bad)).toBeNull()
    }
  })

  it('reads a stored value with the Chime as default', () => {
    expect(DEFAULT_NOTIFY_SOUND).toBe('builtin:chime')
    expect(notificationSoundOf(undefined)).toBe('builtin:chime')
    expect(notificationSoundOf({ id: 'builtin:bell' })).toBe('builtin:chime')
    expect(notificationSoundOf('builtin:bell')).toBe('builtin:bell')
    expect(notificationSoundOf('system:1:x.oga')).toBe('system:1:x.oga')
  })

  it('names the media type from the extension', () => {
    expect(soundMediaType('a/b.OGA')).toBe('audio/ogg')
    expect(soundMediaType('b.aif')).toBe('audio/aiff')
    expect(soundMediaType('b.flac')).toBe('audio/flac')
    expect(soundMediaType('b.mp3')).toBe('audio/mpeg')
    expect(soundMediaType('b')).toBe('application/octet-stream')
  })
})

/** A context that records what was scheduled. */
function fakeContext(opts: { decodeFails?: boolean } = {}) {
  const log: { kind: string; [k: string]: unknown }[] = []
  const param = (owner: string): ToneParam => ({
    value: 1,
    setValueAtTime: (value, time) => log.push({ kind: `${owner}.set`, value, time }),
    exponentialRampToValueAtTime: (value, time) => log.push({ kind: `${owner}.ramp`, value, time })
  })
  const buffers: { channels: number; length: number; rate: number; data: Float32Array[] }[] = []
  const ctx: PlayContext = {
    currentTime: 5,
    destination: 'out',
    resume: async () => {},
    createOscillator: () => {
      const osc = {
        type: '',
        frequency: param('freq'),
        connect: () => undefined,
        start: (time: number) => log.push({ kind: 'start', type: osc.type, time }),
        stop: (time: number) => log.push({ kind: 'stop', time })
      }
      return osc
    },
    createGain: () => ({ gain: param('gain'), connect: () => undefined }),
    decodeAudioData: async (data) => {
      log.push({ kind: 'decode', bytes: data.byteLength })
      if (opts.decodeFails) throw new Error('EncodingError')
      return { copyToChannel: () => {} }
    },
    createBuffer: (channels, length, rate) => {
      const entry = { channels, length, rate, data: [] as Float32Array[] }
      buffers.push(entry)
      const buffer: PlayBuffer = { copyToChannel: (source, channel) => (entry.data[channel] = source) }
      return buffer
    },
    createBufferSource: () => ({ buffer: null, connect: () => undefined, start: () => log.push({ kind: 'source.start' }) })
  }
  return { ctx, log, buffers }
}

describe('built-in tones', () => {
  it('has a preset for every built-in, each at most ~1 s and quiet', () => {
    expect(Object.keys(TONES).sort()).toEqual(BUILTIN_SOUNDS.map((s) => s.name).sort())
    for (const [name, partials] of Object.entries(TONES)) {
      expect(partials.length, name).toBeGreaterThan(0)
      expect(toneDuration(partials), name).toBeLessThanOrEqual(1)
      expect(Math.max(...partials.map((p) => p.gain)), name).toBeLessThanOrEqual(0.15)
      expect(partials.reduce((sum, p) => sum + p.gain, 0), name).toBeLessThan(0.3)
      for (const p of partials) {
        // Audible and not shrill; a fade that ends after the peak.
        expect(p.hz, name).toBeGreaterThanOrEqual(200)
        expect(p.hz, name).toBeLessThanOrEqual(6000)
        expect(p.attack ?? 0.015, name).toBeLessThan(p.length)
      }
    }
    // The Chime is the one every notification rang before the picker: E6 then A6.
    expect(TONES.chime.map((p) => p.hz)).toEqual([1318.5, 1760])
  })

  it('schedules each partial with an attack, a fade to silence and a stop after it', () => {
    const { ctx, log } = fakeContext()
    scheduleTone(ctx, TONES.pop, 2)
    expect(log.filter((e) => e.kind === 'start')).toEqual([
      { kind: 'start', type: 'sine', time: 2 },
      { kind: 'start', type: 'sine', time: 2 }
    ])
    // The pop's pitch glides down.
    expect(log.filter((e) => e.kind === 'freq.ramp').map((e) => e.value)).toEqual([260, 520])
    const ramps = log.filter((e) => e.kind === 'gain.ramp')
    expect(ramps.map((e) => e.value)).toEqual([0.14, 0.0001, 0.03, 0.0001])
    expect(Math.max(...log.filter((e) => e.kind === 'stop').map((e) => e.time as number))).toBeCloseTo(2 + 0.14 + 0.02)
    const tri = fakeContext()
    scheduleTone(tri.ctx, TONES['two-tone'], 0)
    expect(tri.log.filter((e) => e.kind === 'start').map((e) => e.type)).toEqual(['triangle', 'triangle'])
  })
})

describe('sound player', () => {
  const starts = (log: { kind: string }[]) => log.filter((e) => e.kind === 'start').length

  it('plays a built-in as tones, and an unknown id as the Chime', async () => {
    const { ctx, log } = fakeContext()
    const player = createSoundPlayer({ context: () => ctx, fetchSystem: async () => null, log: () => {} })
    await player.play('builtin:bell')
    expect(starts(log)).toBe(TONES.bell.length)
    log.length = 0
    await player.play('nonsense')
    expect(starts(log)).toBe(TONES.chime.length)
  })

  it("decodes a system sound's bytes from main, and falls back to the Chime with one log line per id", async () => {
    const { ctx, log } = fakeContext()
    const messages: string[] = []
    const asked: string[] = []
    let answer: { data: Uint8Array; type: string } | null = { data: new Uint8Array([1, 2, 3]), type: 'audio/ogg' }
    const player = createSoundPlayer({
      context: () => ctx,
      fetchSystem: async (id) => {
        asked.push(id)
        return answer
      },
      log: (m) => messages.push(m)
    })
    await player.play('system:0:a.oga')
    expect(log).toEqual([{ kind: 'decode', bytes: 3 }, { kind: 'source.start' }])
    expect(asked).toEqual(['system:0:a.oga'])
    // Gone: main answers null; the Chime rings and it is logged once, however often it rings.
    answer = null
    log.length = 0
    await player.play('system:0:a.oga')
    await player.play('system:0:a.oga')
    expect(starts(log)).toBe(2 * TONES.chime.length)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('system:0:a.oga')
    // Undecodable, and main failing, are the same fallback.
    const broken = fakeContext({ decodeFails: true })
    const p2 = createSoundPlayer({
      context: () => broken.ctx,
      fetchSystem: async () => ({ data: new Uint8Array([9]), type: 'audio/wav' }),
      log: (m) => messages.push(m)
    })
    await p2.play('system:0:b.wav')
    expect(starts(broken.log)).toBe(TONES.chime.length)
    const p3 = createSoundPlayer({
      context: () => broken.ctx,
      fetchSystem: async () => Promise.reject(new Error('ipc')),
      log: (m) => messages.push(m)
    })
    await p3.play('system:0:c.wav')
    expect(messages).toHaveLength(3)
  })

  it('stays silent without audio and never rejects', async () => {
    const messages: string[] = []
    const player = createSoundPlayer({
      context: () => {
        throw new Error('no audio device')
      },
      fetchSystem: async () => null,
      log: (m) => messages.push(m)
    })
    await expect(player.play('builtin:chime')).resolves.toBeUndefined()
    await player.play('builtin:chime')
    expect(messages).toEqual(['notification sound: no audio output'])
  })

  it('reads an AIFF system sound itself (Chromium does not)', async () => {
    const { ctx, log, buffers } = fakeContext()
    const player = createSoundPlayer({ context: () => ctx, fetchSystem: async () => ({ data: aiff({ samples: [0, 16384] }), type: 'audio/aiff' }), log: () => {} })
    await player.play('system:0:Glass.aiff')
    expect(buffers).toEqual([{ channels: 1, length: 2, rate: 44100, data: [new Float32Array([0, 0.5])] }])
    expect(log).toEqual([{ kind: 'source.start' }])
  })
})

/** A small AIFF (or AIFF-C with `codec`) file with 16-bit samples, one or two channels. */
function aiff(opts: { samples: number[]; channels?: number; codec?: string; rate?: number }): Uint8Array {
  const channels = opts.channels ?? 1
  const little = opts.codec === 'sowt'
  const aifc = opts.codec !== undefined
  const commSize = aifc ? 24 : 18
  const ssndData = opts.samples.length * 2
  const total = 12 + 8 + commSize + 8 + 8 + ssndData
  const view = new DataView(new ArrayBuffer(total))
  const tag = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'FORM')
  view.setUint32(4, total - 8)
  tag(8, aifc ? 'AIFC' : 'AIFF')
  tag(12, 'COMM')
  view.setUint32(16, commSize)
  view.setInt16(20, channels)
  view.setUint32(22, opts.samples.length / channels)
  view.setInt16(26, 16)
  // 80-bit extended sample rate: exponent and a normalised mantissa.
  const rate = opts.rate ?? 44100
  const exp = Math.floor(Math.log2(rate))
  view.setUint16(28, 16383 + exp)
  view.setUint32(30, Math.round((rate / 2 ** exp) * 2 ** 31))
  view.setUint32(34, 0)
  if (aifc) {
    tag(38, opts.codec as string)
    view.setUint16(42, 0) // empty pascal name, padded
  }
  const ssnd = 12 + 8 + commSize
  tag(ssnd, 'SSND')
  view.setUint32(ssnd + 4, 8 + ssndData)
  view.setUint32(ssnd + 8, 0)
  view.setUint32(ssnd + 12, 0)
  opts.samples.forEach((s, i) => view.setInt16(ssnd + 16 + i * 2, s, little))
  return new Uint8Array(view.buffer)
}

describe('AIFF reader', () => {
  it('reads AIFF and uncompressed AIFF-C, big- and little-endian, interleaved channels', () => {
    expect(isAiff(aiff({ samples: [0] }))).toBe(true)
    expect(isAiff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBe(false)
    expect(decodeAiff(aiff({ samples: [0, 16384, -32768, 32767] }))).toEqual({
      sampleRate: 44100,
      frames: 4,
      channels: [new Float32Array([0, 0.5, -1, 32767 / 32768])]
    })
    const stereo = decodeAiff(aiff({ samples: [16384, -16384, 0, 8192], channels: 2, codec: 'sowt', rate: 48000 }))
    expect(stereo.sampleRate).toBe(48000)
    expect(stereo.channels).toEqual([new Float32Array([0.5, 0]), new Float32Array([-0.5, 0.25])])
    expect(decodeAiff(aiff({ samples: [16384], codec: 'NONE' })).channels).toEqual([new Float32Array([0.5])])
  })

  it('refuses compressed AIFF-C and damaged files with an error, never a read past the end', () => {
    expect(() => decodeAiff(aiff({ samples: [0], codec: 'ima4' }))).toThrow(/ima4 is not supported/)
    const file = aiff({ samples: [1, 2, 3, 4] })
    expect(() => decodeAiff(file.slice(0, 30))).toThrow()
    expect(() => decodeAiff(new Uint8Array(4))).toThrow(/not an AIFF/)
    // A COMM that claims more frames than the data holds: only the frames that are there.
    const short = aiff({ samples: [16384, 16384] })
    new DataView(short.buffer).setUint32(22, 1000)
    expect(decodeAiff(short).frames).toBe(2)
    const silly = aiff({ samples: [0] })
    new DataView(silly.buffer).setInt16(20, 0)
    expect(() => decodeAiff(silly)).toThrow(/0 channels/)
  })
})
