---
worth: yes
where: src/main/hooks/ccc-offer.ts
added: 2026-11-20
---
# say so when Claude Code is not installed, and how to install it

Oleg, 2026-11-20, for the next release: at first start cc-cockpit checks whether `ccc` is installed and offers to
install it (`main/hooks/ccc-offer.ts`, `CccOfferDialog`); on a server where Claude Code itself was not installed nothing
said so (seen on the Debian server). The app should check for `claude` the same way and suggest installing it.

Today a Claude tab spawns `claude` (`main/tabs/claude-argv.ts:64`) and, when it is missing, the tab just fails with the
shell's "command not found"; quick chat has its own `claude --help` flag check (editor host).

What it needs:
- **The check**: `claude` resolved on the PATH the Claude tabs get (the same environment the pty spawns with, login
  shell PATH on a Mac started from Finder), at start and when a Claude tab fails to start with "not found". Missing →
  the offer; found → nothing.
- **The offer**: unlike `ccc`, the app does not install Claude Code itself silently. Show what is missing and the
  official install command with Copy and a link to Anthropic's install docs (read the current command from the docs
  when building it, never from memory), plus **Install in a new tab** (decided, Oleg 2026-11-20): it opens a shell tab
  that runs the official installer, visible, so the person watches it and can stop it; the command is argv-only and
  fixed in the app, never built from text the app read elsewhere.
- **Server mode**: the ccc offer never shows there (its modal sat on the hidden page, design-web.md §9.9). This one must
  reach the browsers: a notice to browser views (`ViewRegistry.toBrowserViews`, like the link notice) and a line in
  the core notices / `ccc web status`, so a server with no Claude Code says so where the person looks.
- Same rules as the ccc offer otherwise: once per launch to the first window that asks, "Don't ask again", never in a
  test run unless a spec opts in.
