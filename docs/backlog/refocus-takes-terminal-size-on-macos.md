---
worth: yes
where: test/e2e/web-access-terminal.spec.ts:224
added: 2026-11-19
---
# e2e "focused again does not take the size" fails on macOS, on master too

The web-access spec's refocus case expects a terminal sized by a browser (10x47) to keep that size when the desktop
window is blurred and focused again; on this Mac the desktop takes it back (39x149). Found in the guest-invite team
run (dev-alice), bisected by dev-kira: with `--repeat-each=4` it fails 4/4 at 5100660 (master before any guest code),
at 40c2bac and f627f26, and 5/5 later; one single run passed. So it predates the guest work. The e2e suite grew up on
the Linux VM, and the run's load was high (several members running tests), so it is either a macOS focus-event timing
difference in the test or a real breach of the rule "a window regaining focus takes nothing until the first press or
key there" (CLAUDE.md, terminal size; `view-sizes.ts`) on macOS. First step: run it alone on an idle Mac, then log
which path takes the size on refocus.
