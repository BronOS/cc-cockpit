// A stand-in for the renderer build's output (out/renderer) the web access gateway serves
// (main/web/shell-files.ts): the web shell's page and a few content-hashed assets, plus the files
// next to them the gateway must never serve (the desktop page, main's code).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FAKE_SHELL_HTML = '<!doctype html><title>cc-cockpit</title><script type="module" src="../assets/web-abc123.js"></script>'
export const FAKE_SHELL_JS = 'console.log("web shell")'

/** Writes the fake build under `dir` and returns `dir` (the gateway's `shellDir`). */
export function writeFakeShellDir(dir: string): string {
  mkdirSync(join(dir, 'web'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'web', 'index.html'), FAKE_SHELL_HTML)
  writeFileSync(join(dir, 'assets', 'web-abc123.js'), FAKE_SHELL_JS)
  writeFileSync(join(dir, 'assets', 'styles-def456.css'), 'body{}')
  writeFileSync(join(dir, 'assets', 'Font-Regular-789.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]))
  // Not to be served: the desktop shell's page (with its own CSP) and anything else under out/.
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>desktop</title>')
  return dir
}
