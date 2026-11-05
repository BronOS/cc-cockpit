---
worth: yes
added: 2026-11-05
---
# release the redesign-inbox-v2 work

The redesign (plan `docs/plans/completed/20261104-redesign-inbox-v2.md`) is committed locally only: branch
`redesign-inbox-v2` here, and `master` in cc-cockpit-{inbox,gmail,chat,jira,calendar}. Nothing is pushed,
tagged or published. Releasing waits for Oleg's go; `git rm` this file in the release commit.

- Rerun the external review first: codex auth had expired during the run (`codex login`, then the phase 3
  review over `git diff master...HEAD`).
- Merge `redesign-inbox-v2` into master (73+ commits, not squashed; squash at merge if wanted).
- Version bumps: the app (from 0.9.7), Inbox (feed v2 is a clean break), Gmail, Chat, Jira, Calendar. Each
  source README states the app and Inbox versions it needs; keep them in step with the bumps.
- Push the public example repo `BronOS/cc-cockpit-plugin-example`: `examples/plugin/sdk/types.ts` (slots,
  overlay buttons and `opener`, settings page, `ctx.sessions` scope/focus/close/rename, global settings,
  `ctx.services.provider`) and `examples/plugin/panels/main.html` (component stylesheet). Copy the types
  again first (`cp src/sdk/types.ts examples/plugin/sdk/types.ts`) and run `npm run build:example`; keep
  the example free of exec, sessions, overlays and secrets, as it is listed.
- Marketplace index: new versions for the Inbox and sources, plus `preview.png` and `category` per listing
  (the index tools now check them; `requiredFrom` in the preview policy sets when they are required).
- Inbox's `skills/inbox-source/contract.md` tells source authors "Needs cc-cockpit 0.10.0": match it to the app
  version actually released (the app has no manifest field for a minimum version).
- Before any push, scan each repo's new commits for a work email, employer name or real data.
