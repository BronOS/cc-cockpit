---
worth: yes
where: scripts/build-kit.mjs
added: 2026-11-26
---
# The kit build's bytes depend on whether node_modules is a symlink

`npm run build:kit` in a worktree whose `node_modules` links to the main checkout writes `../../../../node_modules/...`
into the bundle's module comments (esbuild follows the link to its real path); a clean clone writes
`../node_modules/...`. `kit-build.test.ts` rebuilds in the same tree, so it passes in the worktree and fails on CI.
Found at the 0.28.0 release (run 003): master CI failed, fixed by rebuilding from the main checkout (b3f40139), and
every plugin's vendored copy had to be re-copied.

Fix: `preserveSymlinks: true` in build-kit.mjs's esbuild options (or `legalComments`/no path comments), then check
build-editor.mjs and the other committed builds the same way (they matched this time only because nobody rebuilt them
in a worktree).
