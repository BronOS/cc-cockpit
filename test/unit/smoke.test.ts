// The app name in its four places must agree (electron-builder.yml "Decisions"): Electron derives
// `userData` (the data dir) from package.json `name` in dev and from `productName` when packaged,
// and the CLI recomputes that folder without Electron (paths.ts defaultDataDir). One of them
// renamed alone would split dev and packaged data, or send `ccc` to a folder nobody uses.
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_NAME } from '../../src/shared/app-info'
import { defaultDataDir } from '../../src/main/paths'

const root = join(__dirname, '..', '..')

describe('app name', () => {
  it('package.json name, productName, APP_NAME and the default data dir folder agree', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    const productName = /^productName: (.+)$/m.exec(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))?.[1]
    expect(pkg.name).toBe(APP_NAME)
    expect(productName).toBe(APP_NAME)
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(basename(defaultDataDir(platform, {}, '/home/x'))).toBe(APP_NAME)
    }
  })
})
