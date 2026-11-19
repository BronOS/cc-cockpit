---
worth: yes
added: 2026-11-19
---
# the e2e suite has about 22 failing or flaky specs on macOS, master included

The guest-invite team run (2026-11-19) moved e2e from the Linux VM to this Mac. A full `npm run test:e2e` on master
5100660 fails about 22 specs. On the guest branch it was 279 passed, 28 failed and 43 skipped; every failure there also
fails on master, or depends on load and run order (each was checked alone on both sides). The failures seen:
- split-views :267 and :297, plus split-plugin :132, split-resize and split-restore. In setup, `typeLine`'s click on
  `.terminal-view:not([hidden]) .xterm` (`test/e2e/fixtures.ts:236`) times out with "element is not visible". This
  comes right after `waitForTerminalText` read the shell's ready line, on the second new shell tab after `setSize`.
  Measured alone under load: master 5/28, guest branch 7/28. Likely fix: a fixture-side wait for a visible, sized
  xterm.
- overlay-toolbar :125 and :196, and overlays:345 (focus).
- rooms:110 (Stop poll).
- marketplace-revoked:35 (launch EPERM).
- the Sessions panel spec (flaky).
- editor-split:181 (flaky).
- web-access-terminal:224, which has its own item: `refocus-takes-terminal-size-on-macos.md`.

Unit load flakes seen in the same run (all pass alone): root-absolute-urls, folder-walk, room-log, terminal-mirror,
web-gateway "a socket that stops answering pings", web-guest-pages one-way port; editor lsp-host "initialize never
answered".

First step: run the suite once on an idle Mac with `--workers=1`, then sort the failures into macOS timing in the test
versus real behaviour differences.
