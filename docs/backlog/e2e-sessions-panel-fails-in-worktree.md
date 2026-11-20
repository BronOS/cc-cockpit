---
worth: later
where: test/e2e/web-access-plugins.spec.ts:66
added: 2026-11-20
---
# the Sessions panel web test fails when the e2e runs from a git worktree

`the Sessions panel shows in the browser and on the desktop; a card click selects in its own view only` passes from the
main checkout and fails 3 of 3 from any worktree under `.claude/worktrees/` (seen 2026-11-20 at 618c427 and at master
68be939 alike, so no code change caused it): `locator('.terminal-view:not([hidden]) .xterm').click()` times out with
"element is not stable", then "not visible". Agents run e2e from worktrees, so this test reads as a regression there.
Unknown that would settle its value: what differs in a worktree (the project folder path under `.claude/`, the
`node_modules` symlink, the Sessions panel's changed-file list for that folder) and whether a real person could hit it.
