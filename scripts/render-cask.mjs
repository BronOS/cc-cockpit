// `node scripts/render-cask.mjs <version> <sha256>` prints the Homebrew cask to stdout; publish-cask.yml writes it
// to the tap. Version and hash are the only values written into Ruby, and both are validated to a closed
// alphabet first, so nothing from a release (a tag name, a file) can break out of a Ruby string. Exits 1 with
// one line on stderr on bad input.
import { pathToFileURL } from 'node:url'

import { STABLE } from './stable-version.mjs'
const SHA256 = /^[0-9a-f]{64}$/

export function renderCask(version, sha256) {
  if (typeof version !== 'string' || !STABLE.test(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}, expected x.y.z`)
  }
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new Error(`invalid sha256 ${JSON.stringify(sha256)}, expected 64 lowercase hex digits`)
  }
  // The url and file name follow electron-builder.yml `mac.artifactName`. The macOS floor is Electron's
  // own (node_modules/electron/README.md); raise it when an Electron upgrade does. The caveats' first-launch
  // step is unverified until the Mac run in docs/design.md "To cut a release"; replace it with the result.
  return `cask "cc-cockpit" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/BronOS/cc-cockpit/releases/download/v#{version}/cc-cockpit-#{version}-mac-arm64.dmg"
  name "cc-cockpit"
  desc "Desktop cockpit for Claude Code sessions"
  homepage "https://github.com/BronOS/cc-cockpit"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "cc-cockpit.app"

  zap trash: [
    "~/Library/Application Support/cc-cockpit",
    "~/Library/Caches/cc-cockpit",
    "~/Library/Logs/cc-cockpit",
    "~/Library/Preferences/dev.cc-cockpit.app.plist",
    "~/Library/Saved Application State/dev.cc-cockpit.app.savedState",
  ]

  caveats <<~EOS
    The app is not notarised, so macOS may refuse to open it the first time. The exact step has not
    been tested on a Mac yet. Usually it is System Settings > Privacy & Security > "Open Anyway", or:
    xattr -cr /Applications/cc-cockpit.app

    Quit cc-cockpit before upgrading, or restart it afterwards.
  EOS
end
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2) throw new Error('usage: render-cask.mjs <version> <sha256>')
    process.stdout.write(renderCask(args[0], args[1]))
  } catch (err) {
    console.error(`render-cask: ${err.message}`)
    process.exit(1)
  }
}
