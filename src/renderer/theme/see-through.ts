// The see-through background of a window main made transparent (Settings › Appearance and keys ›
// Window; shared/window-background.ts). DOM-free like theme-store.ts, so unit tests cover it with
// a fake root; apply-see-through.ts wires it to the real document, the prefs and the theme.
//
// How the page draws it (styles.css, "See-through window"): `html.see-through` turns on glass
// tokens, each a theme colour mixed with transparent at `--cc-window-alpha`, on the surfaces that
// may let the desktop through (top bar, tab bar, terminal, zones), and makes the body transparent.
// Every pixel gets exactly one translucent layer: a glass bar over a glass body would compound to
// nearly opaque (two layers at 85 % are 98 %). Because the tokens are `color-mix` over the theme's
// own variables on :root, a theme switch needs nothing here: the mix follows the new colours.
import type { XtermTheme } from '../../shared/theme'
import type { SeeThroughArea } from '../../shared/window-background'

let seeThrough = false

/** Main created this window transparent (`window.info`); set once, before the shell renders. */
export function setSeeThrough(on: boolean): void {
  seeThrough = on
}

/** Whether this window draws see-through backgrounds (tab terminals read it when they are made). */
export function isSeeThrough(): boolean {
  return seeThrough
}

/** The part of the root element the see-through needs; structural so tests can pass a fake. */
export interface SeeThroughRoot {
  classList: { add(name: string): void; toggle(name: string, force: boolean): void }
  style: { setProperty(name: string, value: string): void }
}

/** The class that turns the glass tokens on (styles.css). */
export const SEE_THROUGH_CLASS = 'see-through'

/** The class that keeps the side and bottom zones solid (styles.css; WindowBackground.area 'main'). */
export const SOLID_PANELS_CLASS = 'see-through-main'

/** Turn the glass on for `root`. Only ever turned on: a window's transparency is fixed for its life. */
export function markSeeThrough(root: SeeThroughRoot): void {
  root.classList.add(SEE_THROUGH_CLASS)
}

/** Which surfaces carry the glass (ShellPrefs.seeThroughArea); live, both ways. */
export function applySeeThroughArea(root: SeeThroughRoot, area: SeeThroughArea): void {
  root.classList.toggle(SOLID_PANELS_CLASS, area === 'main')
}

/**
 * The glass's alpha from the setting's percent (ShellPrefs.backgroundOpacity). Clamped although
 * main checks the range: a CSS alpha outside 0–1 is clamped by the browser anyway, but a NaN would
 * make the variable invalid, and every glass token with it would fall back to transparent.
 */
export function windowAlpha(percent: number): string {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 100
  return String(p / 100)
}

/** Set the glass's alpha on `root` (`--cc-window-alpha`); every glass token follows. */
export function applyWindowAlpha(root: SeeThroughRoot, percent: number): void {
  root.style.setProperty('--cc-window-alpha', windowAlpha(percent))
}

/**
 * The colour the terminal's glass is mixed from: xterm's own background, so the terminal keeps the
 * colour it has in an opaque window. A theme may give xterm a background that differs from
 * `--cc-terminal-bg` (which only paints the padding around the text); opaque, the text area shows
 * xterm's. Unset falls back to `--cc-terminal-bg` in the stylesheet.
 */
export function applyTerminalBase(root: SeeThroughRoot, xterm: XtermTheme): void {
  const rgb = xterm.background === undefined ? undefined : rgbOf(xterm.background)
  if (rgb) root.style.setProperty('--cc-terminal-glass-base', `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`)
}

/** xterm's palette when no theme sets a background (its own default). */
const XTERM_DEFAULT_BACKGROUND = '#000000'

/**
 * The palette a tab terminal of a see-through window draws with: its background fully transparent,
 * so the terminal host's glass is the one translucent layer behind the text (the host also covers
 * the padding round the text, which xterm does not paint). The transparent colour keeps the
 * background's own rgb: xterm draws inverse video and dim text with `opaque(background)`, so a
 * plain `transparent` (black) would turn inverse text black on a light theme. The block cursor's
 * text defaults to the background too, so it gets the opaque colour explicitly. A background this
 * cannot read (the theme validator only lets through hex, rgb() and hsl(), all read here) leaves
 * the palette as it is: an opaque terminal, still readable.
 */
export function seeThroughXterm(theme: XtermTheme): XtermTheme {
  const rgb = rgbOf(theme.background ?? XTERM_DEFAULT_BACKGROUND)
  if (!rgb) return { ...theme }
  const { r, g, b } = rgb
  return { ...theme, background: `rgba(${r}, ${g}, ${b}, 0)`, cursorAccent: theme.cursorAccent ?? `rgb(${r}, ${g}, ${b})` }
}

/**
 * The xterm options a terminal's look decides (TerminalSession, at creation and on each theme
 * change): a see-through tab terminal gets the transparent palette and `allowTransparency`, which
 * xterm's docs say costs drawing time (its WebGL and canvas renderers blend every cell), so an
 * opaque window and every terminal overlay go without it and keep the theme's palette as it is.
 */
export function xtermLookOptions(seeThrough: boolean, theme: XtermTheme): { theme: XtermTheme; allowTransparency?: true } {
  // A copy either way: xterm repaints on assignment, and the theme store's palette is shared.
  return seeThrough ? { theme: seeThroughXterm(theme), allowTransparency: true } : { theme: { ...theme } }
}

interface Rgb {
  r: number
  g: number
  b: number
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNC = /^(rgba?|hsla?)\(([^)]*)\)$/i

/**
 * The rgb (0–255, rounded) of a theme colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, rgb()/rgba()
 * and hsl()/hsla() with comma or space separated arguments (the forms shared/theme.ts `isColor`
 * accepts). The colour's own alpha is ignored. undefined for anything else.
 */
export function rgbOf(color: string): Rgb | undefined {
  const value = color.trim()
  const hex = HEX.exec(value)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
  }
  const fn = FUNC.exec(value)
  if (!fn) return undefined
  // "r, g, b, a", "r g b / a": the first three arguments are the colour.
  const args = fn[2]!.split(/[\s,/]+/).filter((a) => a !== '')
  if (args.length < 3) return undefined
  const [a, b, c] = args as [string, string, string]
  if (fn[1]!.toLowerCase().startsWith('rgb')) {
    const channel = (arg: string): number | undefined => {
      const n = parseFloat(arg)
      if (!Number.isFinite(n)) return undefined
      return clampByte(arg.endsWith('%') ? (n / 100) * 255 : n)
    }
    const [r, g, bl] = [channel(a), channel(b), channel(c)]
    return r === undefined || g === undefined || bl === undefined ? undefined : { r, g, b: bl }
  }
  const h = parseFloat(a)
  const s = parseFloat(b) / 100
  const l = parseFloat(c) / 100
  if (![h, s, l].every(Number.isFinite)) return undefined
  return hslToRgb(h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)))
}

function clampByte(n: number): number {
  return Math.round(Math.min(255, Math.max(0, n)))
}

/** CSS Color 4's hsl-to-rgb (h in degrees, s and l in 0–1). */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const f = (n: number): number => {
    const k = (n + (((h % 360) + 360) % 360) / 30) % 12
    const a = s * Math.min(l, 1 - l)
    return clampByte((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  return { r: f(0), g: f(8), b: f(4) }
}
