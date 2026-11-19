---
worth: yes
added: 2026-11-19
---
# no guide to the shell UI's test selectors for e2e writers

In the guest-invite team run (2026-11-19) the blind QA spent about a third of her e2e time guessing selectors: an
approval is an `alertdialog`, not a `dialog`; a list row's Edit button shows only on hover; a context menu left open
covers the next click. Devs read the components and do not hit this; a tester who must not read the implementation
does. A short `test/e2e/SELECTORS.md` (roles and test ids per shell surface: tab strip, panes, approval dialogs,
menus, settings pages, the web access page) plus the helpers in `fixtures.ts` would make blind e2e cheap. A drift
test could check that every listed test id still exists in `src/renderer`.
