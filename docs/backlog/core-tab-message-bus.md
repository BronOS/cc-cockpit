---
worth: designed: docs/design-rooms.md
where: src/main/sessions/send-gate.ts, src/main/claude-plugins/, src/cli/
added: 2026-11-13
---
# core communication layer between Claude tabs: messages and shared docs

The team experiment (`~/Projects/team-experiment`, plugin `bronos.team`) runs a lead tab and member tabs that talk through
the plugin's `ccc team send` / `inbox` (messages) and `ccc team doc ls|get|put|share` (shared docs, an abstraction over
files in a run dir: no permission prompts, blind work enforced, every read and write logged). Both halves should be one
core primitive, generic, with no "team" in it (Oleg, 2026-11-13: the communication layer goes to core, not only the bus).

Why core: a plugin over files cannot enforce anything against a tab that has file tools, and it hits app rules meant for
plugins. What only main can do:

1. **Delivery to a typed tab.** Plugin sends to a tab the person typed in are refused (`SessionInfo.typed`), and the lead
   is always such a tab. The plugin works around it with a mailbox file plus a background `team-wait` loop in the lead.
   Only main can offer a safe path: a person-only "accepts messages" mark on a tab (written like the tab flag, never by a
   plugin or hook), or held messages with a badge in the tab strip and Sessions panel.
2. **Waking a tab without typing.** Core generates the Claude Code plugin every tab runs (`<data>/claude-plugins/`); a
   `Stop` hook could tell Claude "N messages waiting" at the end of its turn (bounded, no loop) instead of the watcher.
3. **Identity.** Main sets the sender, reader and writer from the caller's tab (`CliCall.tabId`), never from the payload.
4. **Shared docs with access enforced by main.** A group's docs live in main's store (plain files the person can open,
   reached by tabs only through core `ccc`), with per-doc read/write rules main checks on every call, shares, and a log
   of every read, write, share and refusal. A missing doc and a refused one answer the same, so blind work stays blind.

Split:
- **Core (mechanism):** groups of tabs; messages (send, read, wake, delivery rules); docs (get, put, list, share, access
  checks, size caps, no paths out of the store, no links); the log; core `ccc` commands for all of it (names to settle,
  e.g. `ccc group send|read|doc ...`); a host API for plugins to create a group, add tabs and set access rules.
- **Plugin (policy):** who is in the group and in what role, the access rules it asks for (members write only their own
  folder, memos blind until shared, kickoffs private), hiring, roles, kickoffs, phases, metrics. A plugin sets rules only
  for groups it created; main enforces them.
Autopilot handing work between sessions is a second user. Plus the open/send caps as the person's per-plugin setting
(`plugin-session-open-limit-for-teams.md`).

Security (the design has to settle): a message or doc is untrusted text entering a Claude session; one tab that read a
hostile page must not be able to steer the others or read what it was not given.
- Nothing by default: a tab receives and reads only in a group it is in (opened into it by a plugin, or added by the
  person).
- Each message labelled with its sender and delivered as quoted content, never as the person.
- Nothing typed into a typed tab unless the person allowed it for that tab.
- Rate and size caps; the log visible to the person.

Inputs from the experiment (`runs/*/messages.jsonl`, metrics): message and doc volume, how many messages went to typed
tabs (mailbox), how often a tab needed waking, doc refusals, what broke. Process: design doc (design.md section or its
own), then a plan; the guide topics and drift tests change with it.
