// Minimal PNG files for the preview checks: the signature and chunk framing only, with zero CRCs and
// no real image data, since the checks under test read the framing and decode nothing.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

export interface FakePngOptions {
  width?: number
  height?: number
  /** Adds an `acTL` chunk: an animated PNG. */
  animated?: boolean
  /** Bytes of IDAT payload, to reach a file size. */
  dataBytes?: number
}

export function fakePng(opts: FakePngOptions = {}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(opts.width ?? 1280, 0)
  ihdr.writeUInt32BE(opts.height ?? 800, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...(opts.animated === true ? [chunk('acTL', Buffer.alloc(8))] : []),
    chunk('IDAT', Buffer.alloc(opts.dataBytes ?? 16)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
