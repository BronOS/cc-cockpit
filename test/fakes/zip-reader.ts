// A strict reader for the zips `main/files/zip-writer.ts` writes (tests only): it starts from the end
// record and the central directory, as unzippers do, then checks every local header and data
// descriptor against them, that the records lie back to back with nothing between or after them, and
// each entry's CRC and size against its inflated bytes. Anything off throws, so a test that reads a
// zip has checked its layout too.
import { crc32, inflateRawSync } from 'node:zlib'

export interface ZipReadEntry {
  name: string
  flags: number
  method: number
  versionMadeBy: number
  versionNeeded: number
  dosTime: number
  dosDate: number
  crc: number
  compressedSize: number
  size: number
  externalAttrs: number
  /** The upper half of the external attributes: the Unix mode (type and permission bits). */
  mode: number
  /** The `0x5455` mtime in the central directory, Unix seconds (signed). */
  mtime: number | undefined
  data: Buffer
}

export function readZip(zip: Buffer): ZipReadEntry[] {
  if (zip.length < 22) throw new Error('too short for an end record')
  const end = zip.length - 22
  if (zip.readUInt32LE(end) !== 0x06054b50) throw new Error('no end record at the end (a comment, or a truncated zip)')
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0) throw new Error('multi-disk')
  const count = zip.readUInt16LE(end + 8)
  if (zip.readUInt16LE(end + 10) !== count) throw new Error('entry counts differ')
  const cdSize = zip.readUInt32LE(end + 12)
  const cdOffset = zip.readUInt32LE(end + 16)
  if (zip.readUInt16LE(end + 20) !== 0) throw new Error('a comment')
  if (cdOffset + cdSize !== end) throw new Error('the central directory does not end at the end record')

  const entries: ZipReadEntry[] = []
  let at = cdOffset
  let expectLocal = 0
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`central header ${i}: bad signature`)
    const versionMadeBy = zip.readUInt16LE(at + 4)
    const versionNeeded = zip.readUInt16LE(at + 6)
    const flags = zip.readUInt16LE(at + 8)
    const method = zip.readUInt16LE(at + 10)
    const dosTime = zip.readUInt16LE(at + 12)
    const dosDate = zip.readUInt16LE(at + 14)
    const crc = zip.readUInt32LE(at + 16)
    const compressedSize = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLen = zip.readUInt16LE(at + 28)
    const extraLen = zip.readUInt16LE(at + 30)
    const commentLen = zip.readUInt16LE(at + 32)
    const externalAttrs = zip.readUInt32LE(at + 38)
    const localOffset = zip.readUInt32LE(at + 42)
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLen)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    const mtime = extendedMtime(zip.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen))
    at += 46 + nameLen + extraLen + commentLen

    if (localOffset !== expectLocal) throw new Error(`${name}: local header at ${localOffset}, expected ${expectLocal}`)
    const l = localOffset
    if (zip.readUInt32LE(l) !== 0x04034b50) throw new Error(`${name}: bad local signature`)
    if (zip.readUInt16LE(l + 4) !== versionNeeded) throw new Error(`${name}: version needed differs`)
    if (zip.readUInt16LE(l + 6) !== flags) throw new Error(`${name}: flags differ`)
    if (zip.readUInt16LE(l + 8) !== method) throw new Error(`${name}: method differs`)
    if (zip.readUInt16LE(l + 10) !== dosTime || zip.readUInt16LE(l + 12) !== dosDate) throw new Error(`${name}: time differs`)
    const lNameLen = zip.readUInt16LE(l + 26)
    const lExtraLen = zip.readUInt16LE(l + 28)
    if (!zip.subarray(l + 30, l + 30 + lNameLen).equals(nameBytes)) throw new Error(`${name}: local name differs`)
    if (extendedMtime(zip.subarray(l + 30 + lNameLen, l + 30 + lNameLen + lExtraLen)) !== mtime) throw new Error(`${name}: local mtime differs`)
    const dataAt = l + 30 + lNameLen + lExtraLen
    const raw = zip.subarray(dataAt, dataAt + compressedSize)
    expectLocal = dataAt + compressedSize
    if (flags & 0x0008) {
      if (zip.readUInt32LE(l + 14) !== 0 || zip.readUInt32LE(l + 18) !== 0 || zip.readUInt32LE(l + 22) !== 0) {
        throw new Error(`${name}: bit 3 with sizes in the local header`)
      }
      const d = expectLocal
      if (zip.readUInt32LE(d) !== 0x08074b50) throw new Error(`${name}: no data descriptor signature`)
      if (zip.readUInt32LE(d + 4) !== crc || zip.readUInt32LE(d + 8) !== compressedSize || zip.readUInt32LE(d + 12) !== size) {
        throw new Error(`${name}: data descriptor differs from the central directory`)
      }
      expectLocal = d + 16
    } else if (zip.readUInt32LE(l + 14) !== crc || zip.readUInt32LE(l + 18) !== compressedSize || zip.readUInt32LE(l + 22) !== size) {
      throw new Error(`${name}: local sizes differ`)
    }
    let data: Buffer
    if (method === 8) data = inflateRawSync(raw)
    else if (method === 0) data = Buffer.from(raw)
    else throw new Error(`${name}: method ${method}`)
    if (data.length !== size) throw new Error(`${name}: inflated to ${data.length}, size says ${size}`)
    if ((crc32(data) >>> 0) !== crc) throw new Error(`${name}: CRC mismatch`)
    entries.push({
      name,
      flags,
      method,
      versionMadeBy,
      versionNeeded,
      dosTime,
      dosDate,
      crc,
      compressedSize,
      size,
      externalAttrs,
      mode: externalAttrs >>> 16,
      mtime,
      data,
    })
  }
  if (at !== end) throw new Error('bytes between the central directory and the end record')
  if (expectLocal !== cdOffset) throw new Error('bytes between the last entry and the central directory')
  return entries
}

function extendedMtime(extra: Buffer): number | undefined {
  let i = 0
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i)
    const len = extra.readUInt16LE(i + 2)
    if (id === 0x5455 && len >= 5 && (extra.readUInt8(i + 4) & 1) !== 0) return extra.readInt32LE(i + 5)
    i += 4 + len
  }
  if (i !== extra.length) throw new Error('a malformed extra field')
  return undefined
}
