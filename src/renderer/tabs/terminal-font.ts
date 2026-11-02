// The terminal font setting (shared/terminal-font.ts) as xterm options, and the wait for the font
// before a terminal measures its cell with it.
import type { ITerminalOptions } from '@xterm/xterm'
import type { TerminalFont } from '../../shared/terminal-font'

/** The xterm options a TerminalFont sets. */
export function xtermFontOptions(font: TerminalFont): Pick<
  ITerminalOptions,
  'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'fontWeight' | 'fontWeightBold'
> {
  return {
    fontFamily: font.family,
    fontSize: font.size,
    lineHeight: font.lineHeight,
    letterSpacing: font.letterSpacing,
    fontWeight: font.weight,
    fontWeightBold: font.boldWeight
  }
}

export function sameFont(a: TerminalFont, b: TerminalFont): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing &&
    a.weight === b.weight &&
    a.boldWeight === b.boldWeight
  )
}

/** Longest wait for a font before measuring anyway (a font that never loads must not freeze the terminals). */
const LOAD_TIMEOUT_MS = 1500

/**
 * Wait until the family can be drawn at both weights: xterm measures the cell once, when the font
 * options change, and a cell measured with a fallback font stays wrong (clipped or gappy glyphs,
 * the wrong cols/rows sent to the PTY) until the next change. For an installed font this resolves
 * at once (nothing to fetch); it matters for a web font that is not loaded yet. Never rejects: an
 * unparsable family (CSS `font` shorthand rules differ a little from xterm's) just skips the wait.
 */
export async function loadTerminalFont(font: TerminalFont): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  const load = Promise.all([
    document.fonts.load(`${font.weight} ${font.size}px ${font.family}`),
    document.fonts.load(`${font.boldWeight} ${font.size}px ${font.family}`)
  ]).catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LOAD_TIMEOUT_MS)
  })
  await Promise.race([load, timeout])
  clearTimeout(timer)
}
