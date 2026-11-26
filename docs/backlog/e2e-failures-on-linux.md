---
worth: yes
where: test/e2e/
added: 2026-11-25
---
# e2e specs that fail on master on the Linux dev box

Found during the Terminal panel's verify (run 002): these fail on master (f0156f74) as well as on `terminal-panel`, on
Oleg's Linux machine (Omarchy), every run. Not investigated; each may be a Linux-only timing or focus difference, a
stale spec, or a real bug.

- `guest-views.spec.ts:152`: the Guests popup covers the Claude tab the spec clicks.
- `guest-upload.spec.ts:125`: Upload here / a drop on the Claude tab.
- `split-plugin.spec.ts:134`: a plugin's open-command `beside` a tab answers `placed: false`.
- `split-restore.spec.ts:85`: `groups.place` beside a plugin command tab gives 2 leaves, not 3.
- `reviewer-annotate.spec.ts:282`
- `tab-command-overlays.spec.ts:51`
- `window-bounds.spec.ts:40` and `:62`

Run 003 (overlay foundation, 2026-11-26, QA's full e2e on 0.27.0 master and the run's branch): `tab-command-overlays.spec.ts:51`
and both `window-bounds.spec.ts` tests still fail alone; new in that list, `project-color.spec.ts:63` fails alone on both.
`server-mode.spec.ts:386` failed once in a full run and passed alone (load flake). The guest, upload, split and
reviewer-annotate ones above were not reported failing in that run.

Also seen (pre-existing, not a failure): a `tabs.create` invoked straight from a page does not show in that page's own
strip until a reload; specs create through the UI.
