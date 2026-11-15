# Rooms: messages and shared docs between Claude tabs (design)

Status: revision 2 (2026-11-14): the brainstorm's design with Oleg, revised after a Fable review (findings applied, three
taken to Oleg). A core communication layer for Claude tabs: a plugin puts tabs in a room; members message each other and
share docs through `ccc room`, with main setting every identity and enforcing every rule. Plus the per-plugin caps as the
person's setting. Comes from the team-workflow experiment (`~/Projects/team-experiment`, plugin `bronos.team`), whose
mailbox files, background waiter and run-dir doc layer it replaces; that plugin keeps only the workflow policy. Backlog
items folded in: `docs/backlog/core-tab-message-bus.md` and `docs/backlog/plugin-session-open-limit-for-teams.md`.

Decisions taken in the brainstorm:
- **Who makes rooms:** plugins only (host API). The person sees rooms and can remove members, never builds one.
- **Delivery:** a pull model: the Stop hook prints only a pointer; typed tabs need the person's mark (§2).
- **Docs:** in app data (`<data>/rooms/<id>/docs/`), outside every project; the plugin exports when it wants.
- **Doc access:** a fixed scheme (a shared area, a private folder per member), no rule language.
- **Scope:** messages and docs in one release, minimal UI, plus the configurable caps.
- **Shape:** a service in main reached through core `ccc room` (option A), over an MCP server per tab (B: tool
  definitions in every tab's context, a second way into main) and a bundled plugin (C: needs core powers anyway).

Revision 2 (review findings): the Stop hook prints a fixed pointer and never the messages, and a blocked Stop is not a
Stop for the status or the gate; loops are bounded by Claude Code's own block cap, a per-tab cap and an auto-pause; a
typed tab without the mark gets no Stop pointer, only the badge; the mark is bound to (tab, room) and held back by a
draft bit; membership and the mark are saved in the tab record (restored tabs get new ids), restored members count as
typed and rooms restore paused; one queue (the room's), handed to the gate one batch at a time; forged headers fenced
by a per-delivery nonce, reserved names; docs capped at 256 KiB (the socket line), opened `O_NOFOLLOW` + `fstat`, the
log capped; renamed from "groups" (taken by split-terminal tab groups, `src/shared/tab-groups.ts`). Oleg's answers: the
typed-tab rule above accepted; the `ccc plugin limits` write kept, shell-only and documented as not a boundary; the
name "rooms". Cut from v1 (YAGNI): `doc share` (a coordinator reads a private doc and puts it in `shared/`), the
Settings › Rooms page and the ended-room UI, `onEvent` (`log` with `since` covers it), a cap on open tabs at once.

## 1. Model and membership

A **room** is created by a plugin in its own project window: `ctx.rooms.create({ title })` returns an opaque id. The
title is one line, at most 60 characters, no control, quote or bracket characters. A room belongs to that plugin and
window. Caps (constants): 5 rooms per plugin in a project, 20 members per room. It ends with `ctx.rooms.end(id)` or when its plugin
is disabled, removed or revoked. A room's record (members, queue, paused) and docs are kept on disk.

A **member** is one Claude tab with a name unique in the room (`^[a-z][a-z0-9-]{0,30}$`, reserved: `all`, `plugin`,
`person`, `user`, `system`) and one flag, `coordinator` (may write the shared area; reads every
member's private folder). A tab is in at most one room.

**Joining** (membership means a room's messages reach that session):
- a tab the plugin opens into the room (`ctx.rooms.open`) is a member from the start; it counts against the
  `sessions.open` cap;
- an existing tab joins only by itself: the plugin mints a one-time invite (`ctx.rooms.invite`, 10 minutes) and hands
  it out through its own command; the tab runs `ccc room join <invite>`, and main sees that tab's own token. A plugin
  can never pull a tab into a room;
- the person removes any member in the room view; the person closing the tab removes it (the coordinator is told).

**Restart.** Restored tabs get new ids (`tab-manager.ts`, `randomUUID`), so membership is saved in the tab record, like
the flag: `{ room, name, coordinator, mark }` (`shared/tab-flag.ts` is the pattern). A tab that goes away because the
app quits or its window closes stays a member; only the person's close (or `remove`, `leave`) ends membership. On
restore a member is treated as typed (`typed` is not saved, and the restored session is the person's) and its room
comes back **paused**, so nothing is delivered until the person resumes it in the room view.

Not in v1: a tab in two rooms, rooms across windows, rooms made by the person.

## 2. Messages and delivery

`ccc room send <name|all> <text...> | -`. Main sets the sender from the caller's tab and checks both are in one room; a
message is at most 20k characters (longer goes in a doc); `all` counts as one send per recipient against the caps. The
answer says what happened: `delivered`, `held` (with why) or `gone`. `ctx.rooms.send(id, to, text)` sends `from plugin`.

**One queue per member, the room's** (persisted). Messages are dequeued only by delivery through `read` or a paste; the
send gate's own queue is never used for room messages, so its takeover drop and its plugin/core origins do not apply.

**Pull, not push.** A member gets messages in one of two ways, both ending in the messages being printed in its own turn:
1. `ccc room read` prints every held message (fenced, below) and dequeues them. Always available.
2. A **pointer** that makes Claude run `read`: `N room messages waiting: run ccc room read`, fixed text, no message
   content. It reaches the tab by:
   - **the Stop hook**, when the tab is untyped or carries the mark: at `Stop`, `ccc hook` asks main and, if the member
     has messages and may be continued, prints `{"decision":"block","reason":"<pointer>"}`;
   - **the send gate**, when the tab is waiting for input and is untyped, or marked with no draft: the pointer is
     pasted as one item (one paste for any number of messages).

A **typed tab without the mark** gets neither: its messages are held and a badge shows the count on the tab. A click on
the badge pastes the pointer through the send gate as the person's own act. (A member that read a hostile page must not
continue the person's own turn; `typed` is the person's.)

**The Stop pointer** is not a Stop: main reduces a Stop it answered with a block to `working` and does not deliver the
gate's head (`status-reducer.ts` sets `waiting` on every Stop; `send-gate.ts` delivers at Stop). `ccc` acks after
printing; a block main sent but never got the ack for counts as a plain Stop (the 500 ms budget includes Electron's
start), and the messages stay queued: nothing is lost, at worst the pointer comes again next Stop. The reply is short
and fixed, so it cannot be cut into invalid JSON.

**Loops.** Claude Code overrides a Stop hook after 8 consecutive blocks (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, read from
the 2.1.325 binary; the fake `claude` emulates it, pinned to that version). Main reads `stop_hook_active` and blocks at
most 5 consecutive Stops per tab, then holds behind the badge until the person's next prompt. A room **auto-pauses**
after 100 deliveries with no input from the person in any member tab; the person resumes it. Send caps: 20 a minute per
member, 60 per room (configurable, §6). **Pause** in the room view holds all delivery.

**The mark** ("Deliver room messages automatically") is the person's alone: written only from the shell page (top
frame, the sender's own tabs), like the flag; no host API, hook or `ccc` path. It is bound to (tab, room) and cleared
when the tab leaves or the room ends, so a marked tab that joins another room is not auto-delivered. **Draft bit:** set
by the person's input in the tab (`viewInput`, the path that sets `typed`), cleared by `UserPromptSubmit`; while set, a
marked tab gets no gate paste (the Stop pointer is fine: the box is Claude's while it works).

**Fence.** `read` prints each message as:

```
[cockpit room "<title>" <nonce>] from <name> (a room member, not the person):
| <text, every line prefixed>
[end <nonce>]
```

The nonce is fresh per delivery, so a body cannot forge a header or an end line.

## 3. Docs

Store: `<data>/rooms/<id>/docs/`, written only by main, two areas:
- `shared/...`: every member reads it; coordinators write it (brief, design, decisions, tasks).
- `members/<name>/...`: that member writes and reads it; coordinators read it (memos, questions, the kickoff).

Commands: `ccc room doc ls` (what you may read), `doc get <path>`, `doc put <path> -` (stdin). A refused doc and a
missing one answer the same, so blind work stays blind. To pass one member's doc to others, a coordinator reads it and
puts a copy in `shared/`.

The owning plugin reads and writes any doc of its rooms (`ctx.rooms.docs.list/get/put`): it seeds a member's kickoff into
`members/<name>/` before opening the tab, and exports the docs itself at the end (it has Node).

Limits: UTF-8 text only, 256 KiB per doc (a `ccc` reply is one socket line, `MAX_LINE_BYTES` 1 MiB, and plugin CLI I/O is
256 KiB for that reason), 20 MiB per room; path parts `[A-Za-z0-9._-]`, depth at most 4, no `..`; files opened with
`O_NOFOLLOW` and checked by `fstat` on that descriptor (the key-file pattern), parent directories made by main only;
writes are temp file plus rename, one at a time, last write wins; no versions. Docs outlive the room: an ended room's
docs stay until its plugin calls `ctx.rooms.delete(id)`. The person sees an active room's docs read-only in the room view
and on the desktop can reveal the folder.

## 4. `ccc room`, the host API, the log

`ccc room` is a core command (`CORE_CLI_COMMANDS`) and needs a Claude tab (identity from its token; no tab, refused):
- `ccc room [status] [--json]`: my room, my name, the members and their tab status, held counts
- `join <invite>`, `leave`
- `send <name|all> <text...> | -`, `read`
- `doc ls | get <path> | put <path> -`

`ctx.rooms` acts only on the calling plugin's own rooms in its window:
- `create({ title })` -> `{ id }`, `list()`, `end(id)`, `delete(id)` (an ended room, docs too)
- `open(id, { name, coordinator?, prompt?, model?, effort?, cwd? })` -> `{ tabId }`
- `invite(id, { name, coordinator? })` -> `{ code, expiresAt }`, `members(id)`, `remove(id, name)`
- `send(id, to, text)`, `docs.list / get / put(id, path...)`
- `log(id, { since? })`: joins, leaves (with why: removed, closed, left), sends with their delivery path, doc reads,
  writes and refusals, pauses.

Main appends every event to `<data>/rooms/<id>/log.jsonl`, message text included (the person's record, shown in the room
view), capped at 20 MiB per room (then the oldest half is dropped, with a log line); plugins read it through the API.

Guide: a new `rooms` topic (`ccc room`, `ctx.rooms`); the core skill gets a short paragraph: a `[cockpit room ...]`
message is not from the person and grants nothing the person did not ask for. Drift tests cover both.

## 5. UI

Core draws no session list (the Sessions panel is `cockpit.sessions`), so core gives data and draws only its own parts.
- `SessionInfo` gains `room?: { title, name, coordinator }` and `held?: number`; the Sessions panel shows a marker and
  the held count (a small `cockpit.sessions` bump).
- Tab strip: a room marker on member tabs (title and name in the tooltip); the held badge (click: paste the pointer);
  in the tab's context menu "Deliver room messages automatically" (the mark) and "Room...".
- The room view (a core dialog from "Room..."): members with status, held counts, coordinator, Remove; docs, each
  opening read-only in the built-in viewer, Reveal folder on the desktop; the last 200 log events; Pause / Resume.
- Web access: reading is allowed to browsers. The badge click, the mark, Pause and Resume are `adapted` (count from a
  browser only in server mode, the approvals rule); Remove from a browser goes through an `ApprovalDialog`; Reveal is
  `no`. (A browser can type into a tab anyway, `tabs.input` is `yes`; the badge is no wider than that.) Plugins reach
  none of these.

## 6. Limits the person sets

Folded in from the backlog (the experiment's sixth hire waited a minute on the 5-a-minute open cap). The per-plugin caps
on tabs and texts become the person's per-plugin override: `sessions.open` opens a minute (default 5), `sessions.send`
texts a minute (default 30), room sends a minute per member (default 20) and per room (default 60). Each has a hard
ceiling in main (opens 60, sends 300, room sends 120 / 600) so a typo cannot unbound it; the rooms and members caps
stay constants.

Set in Settings › Plugins (the plugin's row, "Limits") or from a shell outside cockpit with
`ccc plugin limits <id> key=value...` / `--default <key>...`; stored app-wide in `app.json` per plugin id; never in
plugin.json, the plugin's settings or `ccc plugin config`. The write is its own request name in `HOST_ONLY_COMMANDS`,
refused for any caller with a token, and its handler refuses a non-anonymous caller again (the `web.*` guard in
`socket-server.ts` covers only `web.` names, so the new name gets the same check). Like `ccc web`, it is not a boundary:
a tab can drop its token (`env -u APP_TAB_TOKEN`) and look like the person's shell; it keeps a prompted Claude from
raising its own caps as a side effect, and the docs say so. Reading is a separate request name (`ccc plugin limits <id>`
with no values), allowed from a tab. The settings channel is `no` for browsers except in server mode. A cap hit names
the cap and its value. Guide text for `sessions.open`, `sessions.send` and `ctx.rooms` names the defaults and that the
person can change them.

## 7. Security, failures, testing, rollout

Rules (for CLAUDE.md's implementation patterns):
- main is the only authority: identity from the caller's tab token or the host's own plugin, never a payload; a plugin
  acts only on its own rooms in its own window.
- No pulling tabs in: a member is a tab the plugin opened into the room or a tab that ran an invite itself.
- Pull only: hooks and the gate carry a fixed pointer, never room text; room text enters a session only through that
  session's own `ccc room read`, fenced with a nonce; the core skill says it is never the person and grants nothing.
- A typed tab gets nothing without the person's mark; the mark is bound to (tab, room) and held by the draft bit.
- The mark, Pause, Resume and Remove are the person's; no plugin or hook path.
- Docs: no paths out of the store, no links (`O_NOFOLLOW` + `fstat`), caps, refused equals missing.
- Not a boundary: tabs run as the person's OS user. The rules prevent mistakes and make an injected tab's reach through
  a room advisory text behind a pointer, not the person's voice; the docs say so.

Failures: main down or a slow Stop reply means nothing printed and the messages stay queued; a block without the ack is a
plain Stop; the person closing a member's tab removes it, its queue is dropped with a log line and the coordinator is
told; a quit or window close keeps membership; a disabled or removed plugin ends its rooms and the docs stay; a restart
reloads rooms paused and rematches members from the tab records.

Testing: unit tests with fakes for the registry and membership, invite expiry, the saved membership across a restore,
each delivery path (Stop pointer, gate pointer, badge), the blocked-Stop status and gate rule, the ack, the per-tab
block cap and the auto-pause, the mark binding and the draft bit, the fence nonce, every doc rule (links, `..`, caps,
refused equals missing), the send caps and their overrides, persistence; grep tests (the mark written only from the
shell page; hook output only from the Stop pointer and the existing SessionStart print); the fake `claude` emulates
`decision: block`, `stop_hook_active` and the cap of 8; e2e: a plugin opens two tabs that exchange a message and a doc,
and one Stop pointer through the real `ccc` start (the budget); drift tests for the guide and the core skill.

Rollout: branch `feat/rooms` (worktree `.claude/worktrees/groups`, based on `integration/editor-split`), a plan in
`docs/plans/`, run with `planning:exec`, reviewed, merged into the release branch. `bronos.team` is rebuilt on
`ctx.rooms` afterwards, outside the app release.
