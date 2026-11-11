import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Server mode (design-web.md §9): Electron's `dialog` aborts main under Ozone headless, so every
// native dialog goes through the Dialogs interface (src/main/dialogs/), whose server implementation
// never calls Electron. Only the adapter may import or call `dialog`.

const ROOT = join(__dirname, '..', '..')
const MAIN = join(ROOT, 'src', 'main')
const ALLOWED = new Set(['src/main/dialogs/electron-dialog.ts'].map((p) => p.split('/').join(sep)))

const FORBIDDEN = [
  // `dialog` in an import list from 'electron' (a multi-line list puts it on its own line).
  /^\s*dialog\s*,?\s*$/,
  /import\s*\{[^}]*\bdialog\b[^}]*\}\s*from\s*['"]electron['"]/,
  // electron's `dialog` module used by name, or required.
  /(?<![\w.])dialog\s*\.\s*(showMessageBox|showMessageBoxSync|showOpenDialog|showOpenDialogSync|showSaveDialog|showSaveDialogSync|showErrorBox|showCertificateTrustDialog)\b/,
  /\bdialog\b[^\n]*=\s*require\(\s*['"]electron['"]\s*\)/,
  /\{[^}]*\bdialog\b[^}]*\}\s*=\s*(require\(\s*['"]electron['"]\s*\)|electron)\b/
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Code lines only: a comment may name the rule it follows. */
function offences(file: string, text: string): string[] {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
    .filter(({ text: t }) => FORBIDDEN.some((re) => re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

describe('no direct Electron dialog outside the dialog adapter', () => {
  it('finds none in src/main', () => {
    const found = sources(MAIN).flatMap((p) => {
      const rel = relative(ROOT, p)
      return ALLOWED.has(rel) ? [] : offences(rel, readFileSync(p, 'utf8'))
    })
    expect(found).toEqual([])
  })

  it('every allowed file still exists', () => {
    const all = new Set(sources(MAIN).map((p) => relative(ROOT, p)))
    for (const f of ALLOWED) expect(all.has(f), f).toBe(true)
  })

  it('catches each form it forbids and ignores comments and other members', () => {
    const sample = [
      "import { app, dialog } from 'electron'",
      '  dialog,',
      'dialog.showMessageBox(parent, options)',
      'await dialog.showOpenDialog(options)',
      'dialog.showErrorBox(t, c)',
      "const { dialog } = require('electron')",
      '// dialog.showMessageBox is not allowed here',
      ' * dialog.showErrorBox in a doc comment',
      'dialogs.showMessageBox(parent, options)',
      'this.dialog.showMessageBox(x)'
    ].join('\n')
    expect(offences('x.ts', sample)).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:3', 'x.ts:4', 'x.ts:5', 'x.ts:6'])
  })
})
