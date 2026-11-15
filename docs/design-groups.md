# Groups: messages and shared docs between Claude tabs (design)

Status: revision 1 (2026-11-14), from a brainstorm with Oleg. A core communication layer for Claude tabs: a plugin puts
tabs in a group; members message each other and share docs through `ccc group`, with main setting every identity and
enforcing every rule. Comes from the team-workflow experiment (`~/Projects/team-experiment`, plugin `bronos.team`),
whose own mailbox files, background waiter and run-dir doc layer it replaces; that plugin keeps only the workflow
policy. Backlog items folded in: `docs/backlog/core-tab-message-bus.md`; the caps' configurability stays in
`docs/backlog/plugin-session-open-limit-for-teams.md`.

Decisions taken in the brainstorm:
- **Who makes groups:** plugins only (host API). The person sees groups and can remove members, never builds one.
- **Delivery to a typed tab:** the Stop hook at the end of a turn (nothing typed), plus the person's per-tab
  auto-deliver mark; an idle typed tab without the mark holds its messages behind a badge.
- **Docs:** in app data (`<data>/groups/<id>/docs/`), outside every project; the plugin exports when it wants.
- **Doc access:** a fixed scheme (a shared area, a private folder per member, share), no rule language.
- **Scope:** messages and docs in one release, minimal UI.
- **Shape:** a service in main reached through core `ccc group` (option A), over an MCP server per tab (B: tool
  definitions in every tab's context, a second way into main) and a bundled plugin (C: needs core powers anyway).

## 1. Model and membership

A **group** is created by a plugin in its own project window: `ctx.groups.create({ title })` returns an opaque id.
It belongs to that plugin and window (tabs belong to a window). Caps: 5 groups per plugin, 20 members per group. It
ends with `ctx.groups.end(id)` or when its plugin is disabled, removed or revoked. Groups and their docs are kept on
disk and survive a restart; members are matched again by tab id as tabs restore.

A **member** is one Claude tab with a name unique in the group (`^[a-z][a-z0-9-]{0,30}$`) and one flag,
`coordinator` (may write the shared area and share private docs; the team's lead). A tab is in at most one group.

**Joining** (the security point: membership means a group's messages reach that session):
- a tab the plugin opens into the group (`ctx.groups.open`) is a member from the start; it counts against the
  `sessions.open` cap;
- an existing tab joins only by itself: the plugin mints a one-time invite (`ctx.groups.invite`, 10 minutes) and
  hands it out through its own command; the tab runs `ccc group join <invite>`, and main sees that tab's own token.
  A plugin can never pull a tab into a group;
- the person removes any member in the group view; closing the tab removes it too.

Not in v1: a tab in two groups, groups across windows, groups made by the person.

## 2. Messages and delivery

`ccc group send <name|all> <text...> | -`. Main sets the sender from the caller's tab and checks both are in one group;
a message is at most about 20k characters (longer goes in a doc). Each member has a queue in main, persisted.

Delivery, decided per recipient whenever its state changes:
1. **Working:** held; at its `Stop` the hook asks main and gets the pending messages back as the hook's continue
   reason, so Claude reads them and carries on with nothing typed. A long batch is delivered as "N messages: run
   `ccc group read`".
2. **Waiting for input, and never typed or carrying the person's auto-deliver mark:** typed through the send gate
   (its rules unchanged: only while waiting, bracketed paste, one per `Stop`).
3. **Waiting, typed, no mark:** held, with a badge on the tab; a click on it delivers through the send gate as the
   person's own act; also delivered at the tab's next `Stop`.
4. **Needs permission or a dialog:** held, never typed.

`ccc group read` pulls held messages on demand. Every message is quoted content, never the person:

```
[cockpit group "<title>"] from <name> (a group member, not the person):
<text>
```

The `Stop` hook waits for one reply from main inside the existing 500 ms `ccc hook` budget; main slow or closed means
exit 0 and nothing printed, the messages stay held. The rule "hooks never print" becomes "hooks print only a Stop
delivery". Loops (two members waking each other) are bounded by send caps (about 20 a minute per member, 60 per group)
and by **Pause** in the group view, which holds all delivery.

The **auto-deliver mark** is the person's alone: written only from the shell page (top frame, the sender's own tabs),
like the tab flag; no host API, hook or `ccc` path. It is kept with the tab.

## 3. Docs

Store: `<data>/groups/<id>/docs/`, written only by main, two areas:
- `shared/...`: every member reads it; coordinators write it (brief, design, decisions, tasks).
- `members/<name>/...`: that member writes and reads it; coordinators read it (memos, questions, the kickoff).

A coordinator shares one private doc with `ccc group doc share <path> <name|all>` (no unshare in v1). Commands:
`ccc group doc ls` (what you may read), `doc get <path>`, `doc put <path> -` (stdin). A refused doc and a missing one
answer the same, so blind work stays blind.

The owning plugin reads and writes any doc of its groups (`ctx.groups.docs.list/get/put`): it seeds a member's kickoff
into `members/<name>/` before opening the tab, and exports the docs itself at the end (it has Node), so core has no
export API.

Limits: UTF-8 text only, 1 MB per doc, about 50 MB per group; path parts `[A-Za-z0-9._-]`, depth at most 4, no `..`;
every existing component checked with lstat (no links); writes are temp file plus rename, applied one at a time, last
write wins; no versions. Docs outlive the group: an ended group's docs stay until its plugin or the person deletes
them. The person sees them in the group view (read-only) and on the desktop can reveal the folder.

## 4. `ccc group`, the host API, the log

`ccc group` is a core command (`CORE_CLI_COMMANDS`) and needs a Claude tab (identity from its token; no tab, refused):
- `ccc group [status] [--json]`: my group, my name, the members and their tab status, held counts
- `join <invite>`, `leave`
- `send <name|all> <text...> | -`, `read`
- `doc ls | get <path> | put <path> - | share <path> <name|all>`

`ctx.groups` acts only on the calling plugin's own groups in its window:
- `create({ title })` -> `{ id }`, `list()`, `end(id)`, `delete(id)` (docs too)
- `open(id, { name, coordinator?, prompt?, model?, effort?, cwd? })` -> `{ tabId }`
- `invite(id, { name, coordinator? })` -> `{ code, expiresAt }`, `members(id)`, `remove(id, name)`
- `send(id, to, text)`: labelled `from plugin`
- `docs.list / get / put(id, path...)`
- `log(id, { since? })` and `onEvent(listener)`: joins, leaves, sends with their delivery path, doc reads, writes,
  shares and refusals, pause.

Main appends every event to `<data>/groups/<id>/log.jsonl`, message text included (the person's record, shown in the
group view); plugins read it through the API, never as a file. Caps are constants for now; the limits backlog item
makes them the person's setting.

Guide: a new `groups` topic (`ccc group`, `ctx.groups`); the core skill gets a short paragraph so every Claude tab
knows a `[cockpit group ...]` message is not from the person and grants nothing the person did not ask for. Drift tests
cover both.

## 5. UI

Core draws no session list (the Sessions panel is `cockpit.sessions`), so core gives data and draws only its own parts.
- `SessionInfo` gains `group?: { title, name, coordinator }` and `held?: number`; the Sessions panel shows a marker
  and the held count (a small `cockpit.sessions` bump).
- Tab strip: a group marker on member tabs (title and name in the tooltip); a held badge that delivers on click; in
  the tab's context menu "Deliver group messages automatically" (the mark) and "Group...".
- The group view (a core dialog from "Group..." or Settings › Groups): members with status, held counts, coordinator,
  Remove; docs, each opening read-only in the built-in viewer, Reveal folder on the desktop; the last 200 log events;
  Pause / Resume; Delete for an ended group.
- Settings › Groups: the project's groups, active and ended, each opening the group view.
- Web access: reading is allowed to browsers; Pause, Remove, Delete, the badge click and the mark are `adapted`
  channels that count from a browser only in server mode (the approvals rule); plugins reach none of them.

## 6. Security, failures, testing, rollout

Rules (for CLAUDE.md's implementation patterns):
- main is the only authority: identity from the caller's tab token or the host's own plugin, never a payload; a
  plugin acts only on its own groups in its own window.
- No pulling tabs in: a member is a tab the plugin opened into the group or a tab that ran an invite itself.
- Messages are labelled and quoted; the core skill says group text is never the person and grants nothing.
- The mark, Pause, Remove and Delete are the person's; no plugin or hook path.
- Docs: no paths out of the store, no links, caps, refused equals missing.
- Not a boundary: tabs run as the person's OS user. The rules prevent mistakes and keep a prompt-injected tab from
  spreading through the bus; the docs say so.

Failures: main down or a slow Stop reply means nothing printed and the messages stay held; a closed tab leaves its
group (its held messages are dropped with a log line); a disabled or removed plugin ends its groups and the docs stay;
a restart reloads groups and queues and rematches members.

Testing: unit tests with fakes for the registry and membership, invite expiry, each delivery rule, the Stop reply in
budget, every doc rule (links, `..`, caps, refused equals missing), the send caps, persistence and restart; grep tests
(the mark is written only from the shell page; hooks print only from the Stop delivery); one e2e where a plugin opens
two tabs (the fake `claude`) that exchange a message and a doc; drift tests for the guide and the core skill.

Rollout: branch `feat/groups` (worktree `.claude/worktrees/groups`), a plan in `docs/plans/`, run with
`planning:exec`, reviewed, merged into the release branch. `bronos.team` is rebuilt on `ctx.groups` afterwards,
outside the app release.
