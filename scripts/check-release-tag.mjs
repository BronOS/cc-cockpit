// `node scripts/check-release-tag.mjs <tag> [package.json]`, the first step of release.yml: the tag must be
// `v` + the package.json version, and that version a stable x.y.z. A prerelease tag fails here on purpose:
// the build names its files after package.json, and the cask and the update check accept only x.y.z.
// The optional path is for the tests. Exits 1 with one line on stderr, 0 silently.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STABLE } from './stable-version.mjs'

function problem(tag, version) {
  if (typeof tag !== 'string' || !tag) return 'no tag given'
  if (typeof version !== 'string') return 'package.json has no version'
  if (!STABLE.test(version)) return `package.json version ${JSON.stringify(version)} is not a stable x.y.z`
  if (tag !== `v${version}`) return `tag ${JSON.stringify(tag)} is not v${version}, the package.json version`
  return null
}

const [tag, pkgPath = join(import.meta.dirname, '..', 'package.json')] = process.argv.slice(2)
let version
try {
  version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
} catch (err) {
  console.error(`check-release-tag: cannot read ${pkgPath}: ${err.message}`)
  process.exit(1)
}
const found = problem(tag, version)
if (found) {
  console.error(`check-release-tag: ${found}`)
  process.exit(1)
}
