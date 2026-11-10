// A QR code as SVG path data, drawn by React (no markup string, so nothing to inject). The matrix
// comes from `qrcode-generator` (pinned in package.json); error correction M, the smallest version
// that holds the text. Used for the access link and the one-time "add a device" link, which a phone
// scans (design-web.md §4.2, §4.4).
import qrcode from 'qrcode-generator'

export interface QrCode {
  /** Modules per side, without the quiet zone. */
  size: number
  /** One `M x y h1 v1 h-1 z` square per dark module, in module units. */
  path: string
}

/** The code for `text`, or undefined when it does not fit (a link is ~70 characters, far below the limit). */
export function qrOf(text: string): QrCode | undefined {
  if (text === '') return undefined
  try {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const size = qr.getModuleCount()
    let path = ''
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`
      }
    }
    return { size, path }
  } catch {
    return undefined
  }
}
