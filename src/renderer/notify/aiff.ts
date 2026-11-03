// AIFF and AIFF-C to PCM, for the notification sound (renderer/notify/sound-player.ts). macOS's
// /System/Library/Sounds are AIFF, which Chromium's decodeAudioData does not read; this turns the
// uncompressed forms into float samples for an AudioBuffer. Compressed AIFF-C (ima4, ulaw...) is
// refused with an error, and the player then rings the Chime.
//
// The bytes come from main (a listed file under 2 MiB) but the file itself is whatever is on disk:
// every size and offset is checked against the buffer, so a damaged file throws, never reads past it.
// Pure, no DOM: unit-tested under Node.

export interface Pcm {
  sampleRate: number
  frames: number
  /** One array per channel, samples in -1..1. */
  channels: Float32Array[]
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
}

/** `FORM....AIFF` or `FORM....AIFC`. */
export function isAiff(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const form = tag(view, 8)
  return tag(view, 0) === 'FORM' && (form === 'AIFF' || form === 'AIFC')
}

/** The 80-bit IEEE extended float of COMM's sample rate. */
function extended(view: DataView, at: number): number {
  const exp = ((view.getUint8(at) & 0x7f) << 8) | view.getUint8(at + 1)
  const hi = view.getUint32(at + 2)
  const lo = view.getUint32(at + 6)
  if (exp === 0 && hi === 0 && lo === 0) return 0
  const value = (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63)
  return view.getUint8(at) & 0x80 ? -value : value
}

/** Decode an AIFF or uncompressed AIFF-C file (NONE, twos, sowt, fl32, fl64). Throws on anything else. */
export function decodeAiff(bytes: Uint8Array): Pcm {
  if (!isAiff(bytes)) throw new Error('not an AIFF file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const aifc = tag(view, 8) === 'AIFC'
  let comm: { channels: number; frames: number; bits: number; rate: number; codec: string } | undefined
  let data: { at: number; length: number } | undefined
  let at = 12
  while (at + 8 <= view.byteLength) {
    const id = tag(view, at)
    const size = view.getUint32(at + 4)
    const body = at + 8
    if (body + size > view.byteLength && id !== 'SSND') throw new Error(`AIFF chunk ${id} runs past the file`)
    if (id === 'COMM') {
      if (size < 18) throw new Error('AIFF COMM chunk too short')
      const codec = aifc && size >= 22 ? tag(view, body + 18) : 'NONE'
      comm = {
        channels: view.getInt16(body),
        frames: view.getUint32(body + 2),
        bits: view.getInt16(body + 6),
        rate: extended(view, body + 8),
        codec
      }
    } else if (id === 'SSND') {
      if (body + 8 > view.byteLength) throw new Error('AIFF SSND chunk too short')
      const offset = view.getUint32(body)
      const start = body + 8 + offset
      // A writer that never patched the size leaves it too big: the data then ends with the file.
      const end = Math.min(body + size, view.byteLength)
      if (start > end) throw new Error('AIFF SSND offset runs past the chunk')
      data = { at: start, length: end - start }
    }
    at = body + size + (size % 2)
  }
  if (!comm || !data) throw new Error('AIFF without COMM or SSND')
  const { channels, bits, rate, codec } = comm
  if (channels < 1 || channels > 8) throw new Error(`AIFF with ${channels} channels`)
  if (!(rate >= 3000 && rate <= 384000)) throw new Error(`AIFF at ${rate} Hz`)

  let read: (at: number) => number
  let width: number
  if (codec === 'NONE' || codec === 'twos' || codec === 'sowt') {
    if (bits < 1 || bits > 32) throw new Error(`AIFF with ${bits}-bit samples`)
    width = Math.ceil(bits / 8)
    const little = codec === 'sowt'
    const scale = 2 ** (width * 8 - 1)
    read = (p) => {
      let v = 0
      for (let i = 0; i < width; i++) v = v * 256 + view.getUint8(little ? p + width - 1 - i : p + i)
      if (v >= scale) v -= scale * 2 // two's complement
      return v / scale
    }
  } else if (codec === 'fl32' || codec === 'FL32') {
    width = 4
    read = (p) => view.getFloat32(p)
  } else if (codec === 'fl64' || codec === 'FL64') {
    width = 8
    read = (p) => view.getFloat64(p)
  } else {
    throw new Error(`AIFF-C compression ${codec} is not supported`)
  }

  const frameBytes = width * channels
  const frames = Math.min(comm.frames, Math.floor(data.length / frameBytes))
  if (frames < 1) throw new Error('AIFF without samples')
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let f = 0; f < frames; f++) {
    const base = data.at + f * frameBytes
    for (let c = 0; c < channels; c++) {
      const v = read(base + c * width)
      ;(out[c] as Float32Array)[f] = Math.max(-1, Math.min(1, v))
    }
  }
  return { sampleRate: rate, frames, channels: out }
}
