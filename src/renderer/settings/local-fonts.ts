// The installed monospaced font families, for the terminal font dropdown's Installed section. Read through
// Chromium's Local Font Access API (window.queryLocalFonts), which main grants to the shell page's
// own frame only (main/windows/permissions.ts); no system tool is spawned. Not in TypeScript's DOM
// lib yet, hence the local shape.

interface LocalFontData {
  family: string
}

type QueryLocalFonts = () => Promise<LocalFontData[]>

/**
 * A family name as a CSS font-family entry: as is when it is plain words (`MesloLGS NF`), quoted
 * otherwise (`"3270 Nerd Font"`: an unquoted word may not start with a digit).
 */
export function cssFamilyName(name: string): string {
  return /^[A-Za-z_-][\w-]*( [A-Za-z_-][\w-]*)*$/.test(name) ? name : `"${name.replace(/["\\]/g, '\\$&')}"`
}

/**
 * Whether a family draws narrow and wide letters at the same advance. The API says nothing about
 * spacing, so it is measured; a family the canvas cannot use falls back to the default sans-serif
 * and reads as proportional, i.e. it is left out.
 */
function isMonospace(ctx: CanvasRenderingContext2D, family: string): boolean {
  ctx.font = `20px ${cssFamilyName(family)}`
  return Math.abs(ctx.measureText('iiiiiiii').width - ctx.measureText('MMMMMMMM').width) < 0.5
}

/**
 * The monospaced families installed, as their names (`3270 Nerd Font`; cssFamilyName makes the CSS
 * entry), sorted; null when they cannot be listed (no API, the permission refused, or no user
 * activation: call it from the click or key that opens the dropdown, not after an await).
 */
export async function installedMonospaceFamilies(): Promise<string[] | null> {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  if (typeof query !== 'function') return null
  let fonts: LocalFontData[]
  try {
    fonts = await query.call(window)
  } catch {
    return null
  }
  const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
  const ctx = document.createElement('canvas').getContext('2d')
  return ctx ? families.filter((f) => isMonospace(ctx, f)) : families
}
