// What the release scripts accept as a version: a plain x.y.z with no leading zeros and no prerelease.
// Shared by check-release-tag.mjs and render-cask.mjs so the tag gate and the cask cannot disagree.
// The app's own copies (src/main/updates/update-check.ts, src/cli/client.ts) are separate on purpose:
// they run inside the bundled app and read untrusted text, so they cap the digit count.
export const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
