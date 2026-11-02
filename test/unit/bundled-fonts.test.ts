// The bundled terminal fonts (renderer/assets/fonts): the @font-face rules in fonts.css must
// declare exactly the families shared/terminal-font.ts names (a renamed family would leave the
// default font silently falling back to `monospace`), every file they point at must be there and
// be WOFF2, each face must be declared at the weights and styles xterm asks for, and the licence
// texts the fonts are redistributed under must sit next to them.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_TERMINAL_FONTS } from '../../src/shared/terminal-font'

const FONTS = resolve(__dirname, '../../src/renderer/assets/fonts')
const CSS = readFileSync(join(FONTS, 'fonts.css'), 'utf8')

interface Face {
  family: string
  url: string
  weight: string
  style: string
}

function faces(css: string): Face[] {
  const out: Face[] = []
  for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const prop = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(body!)?.[1]?.trim() ?? ''
    out.push({
      family: prop('font-family').replace(/^['"]|['"]$/g, ''),
      url: /url\('([^']+)'\)/.exec(prop('src'))?.[1] ?? '',
      weight: prop('font-weight'),
      style: prop('font-style')
    })
  }
  return out
}

describe('bundled terminal fonts', () => {
  const declared = faces(CSS)

  it('fonts.css declares exactly the bundled families, regular, bold, italic and bold italic of each', () => {
    expect([...new Set(declared.map((f) => f.family))].sort()).toEqual(BUNDLED_TERMINAL_FONTS.map((f) => f.family).sort())
    for (const { family } of BUNDLED_TERMINAL_FONTS) {
      const styles = declared.filter((f) => f.family === family).map((f) => `${f.weight} ${f.style}`)
      expect(styles.sort(), family).toEqual(['400 italic', '400 normal', '700 italic', '700 normal'])
    }
  })

  it('every face points at a WOFF2 file that is there', () => {
    expect(declared).toHaveLength(8)
    for (const face of declared) {
      const file = join(FONTS, face.url)
      expect(existsSync(file), face.url).toBe(true)
      // The WOFF2 signature: `wOF2`.
      expect(readFileSync(file).subarray(0, 4).toString('latin1'), face.url).toBe('wOF2')
    }
  })

  it('ships the licence of each font next to it', () => {
    const dirs = new Set(declared.map((f) => dirname(join(FONTS, f.url))))
    expect(dirs.size).toBe(2)
    expect(readFileSync(join(FONTS, 'jetbrains-mono-nf/OFL.txt'), 'utf8')).toContain('SIL Open Font License, Version 1.1')
    expect(readFileSync(join(FONTS, 'meslolgs-nf/LICENSE.txt'), 'utf8')).toContain('Apache License, Version 2.0')
    expect(readFileSync(join(FONTS, 'meslolgs-nf/LICENSE-2.0.txt'), 'utf8')).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
  })
})
