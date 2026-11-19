# Rooms: messages and shared docs between Claude tabs (design)

Status: revision 2 (2026-11-14): the brainstorm's design with Oleg, revised after a Fable review (findings applied, three
taken to Oleg). Revision 3 (2026-11-19, Oleg): the mark starts on at every join (§2 "The mark"), a deliberate loosening
of the typed-tab rule. A core communication layer for Claude tabs: a plugin puts tabs in a room; members message each other and
share docs through `ccc room`, with main setting every identity and enforcing every rule. Plus the per-plugin caps as the
person's setting. Comes from the team-workflow experiment (`~/Projects/team-experiment`, plugin `bronos.team`), whose
mailbox files, background waiter and run-dir doc layer it replaces; that plugin keeps only the workflow policy. Backlog
items folded in (and deleted): the core tab message bus and the plugin `sessions.open` limit for teams.

Decisions taken in the brainstorm:
- **Who makes rooms:** plugins only (host API). The person sees rooms and can remove members, never builds one.
- **Delivery:** a pull model: the Stop hook prints only a pointer; typed tabs need the person's mark (§2), which is on
  from the join since revision 3.
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
a Settings › Rooms page, `onEvent` (`log` with `since` covers it), a cap on open tabs at once.

Revision 3 (2026-11-19, Oleg's decision): a join starts **marked**, for every member, the person's own tabs included.
With the mark off by default, any key in a member tab (an arrow, a wheel scroll in Claude's full-screen view, a
permission answer) made it typed and silently held every room message to it behind the badge: in team runs one stray
key blocked a member. Everything else about the mark stays (the person's alone after the join, bound to (tab, room),
held by the draft bit, Pause / Resume / Remove unchanged); §2 "The mark" says what this loosens and why.

## 1. Model and membership

A **room** is created by a plugin in its own project window: `ctx.rooms.create({ title })` returns an opaque id. The
title is one line, at most 60 characters, no control, quote or bracket characters. A room belongs to that plugin and
window. Caps: 5 rooms per plugin in a project, 20 members per room (both defaults the person can change, §6), 50 ended rooms kept per plugin in a project
(an ended room stays until `delete`; past 50, `create` refuses until one is deleted, never dropping one by itself), 20 one-time invites waiting per room, 100 messages waiting per member and 1,000,000 characters of waiting messages per room (a send past the last two is `refused`), 1000 files and folders in a room's docs. It ends with `ctx.rooms.end(id)` (`ctx.rooms.remove(id, name, { closeTab: true })` closes one member's tab under the same rule, `registry.closableTab`; `{ closeTabs: true }` also closes the tabs `rooms.open` made for it, with no dialog, except a coordinator's, an invited member's and any the person typed into; main decides from flags saved per member, `opened` and `personTyped`, never from the plugin) or when its plugin
is disabled, removed or revoked. A room's record (members, queue, paused) and docs are kept on disk.

A **member** is one Claude tab with a name unique in the room (`^[a-z][a-z0-9-]{0,30}$`, reserved: `all`, `plugin`,
`person`, `user`, `system`) and one flag, `coordinator` (may write the shared area; reads every
member's private folder). A tab is in at most one room.

**Joining** (membership means a room's messages reach that session):
- a tab the plugin opens into the room (`ctx.rooms.open`) is a member from the start; it counts against the
  `sessions.open` cap, and takes `sessions.open`'s `beside` / `side` (a split pane beside a tab of the host's window,
  checked by main the same way before the cap is spent, answered with `placed`, never focused);
- an existing tab joins only by itself: the plugin mints a one-time invite (`ctx.rooms.invite`, 10 minutes) and hands
  it out through its own command; the tab runs `ccc room join <invite>`, and main sees that tab's own token. A plugin
  can never pull a tab into a room;
- the person removes any member in the room view; the person closing the tab removes it (every coordinator gets a `system` message, `<name> left: tab closed`).

**Restart.** Restored tabs get new ids (`tab-manager.ts`, `randomUUID`), so membership is saved in the tab record, like
the flag: `{ room, name, coordinator, mark }` (`shared/tab-flag.ts` is the pattern). A tab that goes away because the
app quits or its window is reopened (Settings › Window's "Reopen window") stays a member; the person's close (or
`remove`, `leave`) ends membership. Closing the project's window for good counts as the person closing its tabs: their
saved records are cleared with it, so nothing could bind those members again, and every member of the project's rooms
leaves `closed` (coordinators told, queues dropped). On restore a member is treated as typed (`typed` is not saved, and
the restored session is the person's) and its room comes back **paused**, so nothing is delivered until the person
resumes it in the room view: rooms are read paused at start-up, and any rebind of a restored member pauses its room
too, so a window reopened within the run (or opened later in it) restores the same way.

Not in v1: a tab in two rooms, rooms across windows, rooms made by the person.

## 2. Messages and delivery

`ccc room send <name|all> <text...> | -`. Main sets the sender from the caller's tab and checks both are in one room; a
message is at most 20k characters (longer goes in a doc); `all` counts as one send per recipient against the caps. The
answer says what happened: `delivered`, `held` (with why) or `gone`. `ctx.rooms.send(id, to, text)` sends `from plugin`.

**One queue per member, the room's** (persisted). Messages are dequeued only by the member's own acked `read` (a paste
delivers only the pointer); the send gate's own queue is never used for room messages, so its takeover drop and its
plugin/core origins do not apply.

**Pull, not push.** A member gets messages in one of two ways, both ending in the messages being printed in its own turn:
1. `ccc room read` prints the oldest held messages that fit about 25k characters (`ROOM_READ_MAX_TEXT_BYTES`, what Claude Code's Bash tool
   shows inline; always at least one, so a single long message may pass it) (fenced, below; when more wait, the pointer
   for them after the last fence) and dequeues them once `ccc` acks that its stdout write completed (`room.read.ack`, protocol.ts
   `ROOM_READ_ACK_COMMAND`): a read whose reply never reached Claude (Esc, the deadline, a closed socket) is read again
   by the next one, so a message is shown at least once and never lost. Always available.
2. A **pointer** that makes Claude run `read`: `N room messages waiting: run ccc room read`, fixed text, no message
   content. It reaches the tab by:
   - **the Stop hook**, when the tab is untyped or carries the mark: at `Stop`, `ccc hook` asks main and, if the member
     has messages and may be continued, prints `{"decision":"block","reason":"<pointer>"}`;
   - **the send gate**, when the tab is waiting for input and is untyped, or marked with no draft: the pointer is
     pasted as one item (one paste for any number of messages). A message that arrives while the tab is still in the
     1 s settle window after its `SessionStart` is held as `not-waiting` and offered again when the window ends, under
     the same rules (a paused room, a typed tab without the mark and a draft still hold it).

A **typed tab without the mark** gets neither: its messages are held and a badge shows the count on the tab. A click on
the badge pastes the pointer through the send gate as the person's own act. (A member that read a hostile page must not
continue the person's own turn; `typed` is the person's.) Since revision 3 a tab is in this state only when the person
turned its mark off (or a tab record saved before revision 3 is restored unmarked): a join starts marked.

**The Stop pointer** is not a Stop: main reduces a Stop it answered with a block to `working` and does not deliver the
gate's head (`status-reducer.ts` sets `waiting` on every Stop; `send-gate.ts` delivers at Stop). `ccc` acks the block
on the same connection first and prints it only once main confirmed the ack, all within its Stop budget (2 s after
`ccc` has started; Electron's start, about 100 ms, comes before it; Claude Code's hook timeout is 5 s). So a connection
that closes with the block unacked (a main too slow for the budget, a `ccc` that died) proves nothing was printed, and
main applies the plain Stop then (`waiting`, the gate's head delivered). An ack main took whose print then failed
(stdout closed) leaves the tab `working` with Claude stopped: the safe direction, since `waiting` while the turn goes
on could paste into it. A tab wrongly left `working` recovers at the person's next prompt, as after an interrupted turn. When the connection
closes unacked, main also offers the member's pointer again once the plain Stop is applied. A `ccc` that holds its
connection open without acking is waited for 5 s (`ACK_TIMEOUT_MS`), then a log line; the block stays as it is (the
tab `working`) until its next hook or the connection's close undoes it. Main checks the member again at the ack (same
rule as at the Stop): a pause, the room's end, a cleared mark or the person's takeover in between answers the ack
`acked: false`, so `ccc` prints nothing and the connection's close applies the plain Stop.
The messages stay queued: nothing is lost, at worst the pointer comes again next Stop. The reply is short
and fixed, so it cannot be cut into invalid JSON.

**Loops.** Claude Code overrides a Stop hook after 8 consecutive blocks (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, read from
the 2.1.325 binary; the fake `claude` emulates it, pinned to that version). Main reads `stop_hook_active` and blocks at
most 5 consecutive Stops per tab, then holds behind the badge (no Stop pointer and no gate paste: a held `why` of
`capped`) until the person's next prompt in the tab, their badge click (it delivers and ends the cap) or their Resume
of the room; an untyped member gets no prompt from the person, so for it the badge or Resume is the way. A room **auto-pauses**
after 100 deliveries with no input from the person in any member tab; the person resumes it. Send caps: 20 a minute per
member, 60 per room (configurable, §6). **Pause** in the room view holds all delivery.

**The mark** ("Deliver room messages automatically") is **on when a tab joins a room**, for every member, the person's
own tabs included. The one writer of that initial value is main's own join path (`TabManager.setRoom`, after
`RoomRegistry.addMember` or `redeem`), as a constant: no plugin field, invite, `ccc` argument or hook payload decides it.
After the join it is the person's alone: changed only from the shell page (top frame, the sender's own tabs), like the
flag; no host API, hook or `ccc` path. **This is a deliberate loosening of the typed-tab rule** (revision 3, Oleg's
call): with the mark on, a room message, which may come from a member that read a hostile page, reaches a tab the
person typed in. It still arrives only as the fixed pointer, the text enters only through that tab's own
`ccc room read`, fenced with a nonce, and the draft bit keeps the pointer off any unsent text. The person turns the mark
off per tab when they want their own conversation kept out of the room. The reason for the loosening: with the mark
off by default, any key in a member tab made it typed and silently held all its room traffic behind the badge. The
mark is bound to (tab, room) and dropped when the tab leaves or the room ends; a tab that then joins another room starts
marked again, so the person's "off" in one room does not carry into the next (a coordinator change of the same member
keeps it). That includes the same room: a tab that leaves (its own `ccc room leave`) and joins again (its own `ccc room
join` with a new invite) starts marked, so a member tab can undo the person's "off" by rejoining; accepted with the
rest, since only the tab itself can run both. What the mark does not loosen: the draft bit. A key the person presses
while a marked tab waits for input (an arrow, a wheel scroll; not a permission answer) still holds every gate paste
until their next prompt or their "Deliver anyway"; the Stop pointer is unaffected (the box is Claude's while it works).
A restart restores the mark from the tab record as saved (a restore is not a join); records saved before revision 3
keep their `false`. The toggle and the
badge's click carry the room id and member name the strip showed; main refuses the toggle (and answers the click
`no-room`) when the tab's membership differs by then, so a request that waited while the tab moved never marks or
delivers into the other room. **Draft bit:** set
by the person's input in the tab (`viewInput`, the path that sets `typed`), cleared by `UserPromptSubmit`; while set, a
marked tab gets no gate paste (the Stop pointer is fine: the box is Claude's while it works). A key the prompt takes
while a permission prompt or dialog is up (`needs-permission`: Enter, a digit, an arrow) does not set it: it leaves
nothing in the box. Every other key does, Esc and Ctrl+U included: main cannot see the box, so the bit may only ever
miss a draft that cannot exist. The badge's click on a tab with the bit set answers `draft`, and the strip offers
**Deliver anyway** (`rooms.deliverHeld` with `overDraft`): the person's choice to add the pointer to whatever is in the
box, the one way past the bit. Main offers what waits again only when the mark goes from off to on; clearing it, or
setting it again, delivers nothing.

**Fence.** `read` prints each message as:

```
[cockpit room "<title>" <nonce>] from <name> (a room member, not the person):
| <text, every line prefixed>
[end <nonce>]
```

A message from the owning plugin has the header `from plugin (the plugin running this room, not the person)` and one
from cockpit itself (a member's tab closed) `from system (cockpit itself, not the person)`.

The nonce is fresh per delivery, so a body cannot forge a header or an end line. Control characters (C0 but tab,
DEL, C1) and the bidi and invisible format characters are printed as a visible `\u{..}` escape, so an escape sequence
or a bidi override cannot hide a `| ` or an end line from the person reading the terminal.

## 3. Docs

Store: `<data>/rooms/<id>/docs/`, written only by main, two areas:
- `shared/...`: every member reads it; coordinators write it (brief, design, decisions, tasks).
- `members/<name>/...`: that member writes and reads it; coordinators read it (memos, questions, the kickoff).

Commands: `ccc room doc ls` (what you may read), `doc get <path>`, `doc put <path> -` (stdin) and `doc append <path> -`
(adds to the end, creating the doc when missing); put and append also take `--file <file>` instead of `-` (a regular file
read by `ccc`, at most the doc cap: the way for a tab with no stdin, such as Code Mode's REPL). An append goes through the
same per-room write chain as a put (the old text is read inside it and the whole doc rewritten), so two appends never
interleave or lose text; the cap and the text rule apply to the doc after the append. A refused doc and a missing one
answer the same, so blind work stays blind. To pass one member's doc to others, a coordinator reads it and
puts a copy in `shared/`.

The owning plugin reads and writes any doc of its rooms (`ctx.rooms.docs.list/get/put`): it seeds a member's kickoff into
`members/<name>/` before opening the tab, and exports the docs itself at the end (it has Node).

Limits: UTF-8 text only (no control, bidi or invisible format character but tab, LF and CRLF: the fence's set, so a doc is
safe to print raw into a terminal for `doc get` and its JSON-escaped form is at most twice its size and always fits a `ccc`
reply), 256 KiB per doc (a `ccc` reply is one socket line, `MAX_LINE_BYTES` 1 MiB, and plugin CLI I/O is
256 KiB for that reason), 20 MiB per room; path parts `[A-Za-z0-9._-]`, depth at most 4, no `..`; files opened with
`O_NOFOLLOW` and checked by `fstat` on that descriptor (the key-file pattern), parent directories made by main only;
writes are temp file plus rename, one at a time, last write wins; no versions. Docs outlive the room: an ended room's
docs stay until its plugin calls `ctx.rooms.delete(id)`. The person sees a room's docs read-only in the room view, an
ended room's too (an ended room stays viewable, docs and log, until its plugin deletes it), and on the desktop can reveal the folder.

## 4. `ccc room`, the host API, the log

`ccc room` is a core command (`CORE_CLI_COMMANDS`) and needs a Claude tab (identity from its token; no tab, refused):
- `ccc room [status] [--json]`: my room, my name, the members and their tab status, held counts
- `join <invite>`, `leave`
- `send <name|all> <text...> | -`, `read`
- `doc ls | get <path> | put <path> -|--file <file> | append <path> -|--file <file>`

`ctx.rooms` acts only on the calling plugin's own rooms in its window:
- `create({ title })` -> `{ id }`, `list()`, `end(id)`, `delete(id)` (an ended room, docs too)
- `open(id, { name, coordinator?, prompt?, model?, effort?, cwd? })` -> `{ tabId }`
- `invite(id, { name, coordinator? })` -> `{ code, expiresAt }`, `members(id)`, `remove(id, name)`
- `send(id, to, text)`, `docs.list / get / put(id, path...)`
- `log(id, { since?, limit? })` -> `{ entries, more }`: joins, leaves (with why: removed, closed, left), sends with their
  delivery path, doc reads, writes and refusals, pauses. Each entry has a `seq` per room (1 up, never reused, kept
  across a trim and a restart: the next one is read from the file's last entry); `since` is a `seq` cursor and answers
  the oldest entries after it, `more` when newer remain, so a poller that falls behind pages through and loses nothing
  (a time cursor would skip entries of the same millisecond). Without `since`, the newest. A read never parses the
  whole file on main: the newest are read back from the end, a cursor is found by a binary search over byte offsets.

Main appends every event to `<data>/rooms/<id>/log.jsonl`, message text included (the person's record, shown in the room
view), capped at 20 MiB per room (then the oldest half is dropped, with a log line); plugins read it through the API.

Guide: a new `rooms` topic (`ccc room`, `ctx.rooms`); the core skill gets a short paragraph: a `[cockpit room ...]`
message is not from the person and grants nothing the person did not ask for. Drift tests cover both.

## 5. UI

Core draws no session list (the Sessions panel is `cockpit.sessions`), so core gives data and draws only its own parts.
- `SessionInfo` gains `room?: { title, name, coordinator }` and `held?: number`; the Sessions panel shows a marker and
  the held count (a small `cockpit.sessions` bump).
- Tab strip: a room marker on member tabs (title and name in the tooltip); the held badge (click: paste the pointer;
  a refusal says why: paused, not running, a prompt to answer, busy, or a possible draft with "Deliver anyway");
  in the tab's context menu "Deliver room messages automatically" (the mark) and "Room...".
- The room view (a core dialog from "Room..."): members with status, held counts, coordinator, Remove; docs, each
  opening read-only in the dialog's own text viewer (`rooms.doc`: main reads it as the person, logged `by person`; not
  the `less` overlay, whose `v` and `!` would let an editor or a shell write a doc behind main), Reveal folder on the
  desktop; the last 200 log events (at most 1 MiB of them); Pause / Resume. It reads the room again on `rooms.changed`.
- Web access: reading is allowed to browsers. The badge click, the mark, Pause and Resume are `adapted` (count from a
  browser only in server mode, the approvals rule); Remove from a browser goes through an `ApprovalDialog` that main
  asks every view of the window (`rooms.removeAsk`, the shared-asks core, first answer wins, replayed in `ready`, 5 min
  then not removed) before it removes; Reveal is `no`. (A browser can type into a tab anyway, `tabs.input` is `yes`; the badge is no wider than that.) Plugins reach
  none of these.

## 6. Limits the person sets

Folded in from the backlog (the experiment's sixth hire waited a minute on the 5-a-minute open cap). The per-plugin caps
on tabs and texts become the person's per-plugin override: `sessions.open` opens a minute (default 5), `sessions.send`
texts a minute (default 30), room sends a minute per member (default 20) and per room (default 60). Each has a hard
ceiling in main (opens 60, sends 300, room sends 120 / 600) so a typo cannot unbound it. Later `roomsPerProject` (default 5,
ceiling 20) and `membersPerRoom` (default 20, ceiling 50) joined them; lowering one never evicts, it only refuses new
creates and joins. Then `panesPerGroup` (default 4, the old fixed `GROUP_CAPS.pluginBelow`; least 2, ceiling
`GROUP_CAPS.maxPanes` 8): a plugin's `beside` places a split pane only while the target group has fewer panes, read by
main's TabGroups at each placement (`TabGroupsDeps.pluginPanes`, with the plugin id HostApi put in the placement, never a
payload's); lowering it never ungroups, it only opens later tabs plain. It is the one cap with a least value above 1
(`PluginLimitSpec.min`): an edit under it is refused, a stored value from 1 up but under it reads as it. The storage caps
stay constants.

Set globally in Settings › General ("Plugin limits", or `ccc plugin limits --global`) and per plugin in Settings › Plugins (the plugin's row, "Limits") or from a shell outside cockpit with
`ccc plugin limits <id> key=value...` / `--default <key>...`; stored app-wide in `app.json` per plugin id; never in
plugin.json, the plugin's settings or `ccc plugin config`. The write is `plugin.limits.set` in `HOST_ONLY_COMMANDS`, refused for any caller with a token before lookup, and
its handler refuses a non-anonymous caller again. The prefix `plugin.limits.` is a `HOST_ONLY_FAMILIES` entry (`protocol.ts`,
with `web.`): a handler registered under it and missing from the list is a start-up error, so a later write cannot
forget the guard. Like `ccc web`, it is not a boundary:
a tab can drop its token (`env -u APP_TAB_TOKEN`) and look like the person's shell, and a plugin host (full Node, the
same OS user, no token) can run `ccc plugin limits` the same way or edit `app.json`; it keeps a prompted Claude from
raising its own caps as a side effect, and the docs say so. Reading is a separate request name (`ccc plugin limits <id>`
with no values), allowed from a tab. A plugin's entry is dropped when the plugin is uninstalled (the installer, beside its
secrets), so raised caps never carry over to a different plugin that later takes the id; a write that cannot reach a
read-only `app.json` is refused, not reported as set. The settings channel is `no` for browsers except in server mode. A cap hit names
the cap and its value. Guide text for `sessions.open`, `sessions.send` and `ctx.rooms` names the defaults and that the
person can change them.

Global values (added after the first release): each cap also has a global value (`app.json` › `pluginLimitsGlobal`,
Settings › General "Plugin limits", `ccc plugin limits --global [key=value... | --default <key>...]`), and the
per-plugin value is an override of it: a plugin's cap is its override, else the global value, else the built-in default.
The ceilings, the read-time clamping and the edit checks are the same at both levels. Counting stays per plugin (a global
value is each plugin's own budget, not a shared one), and a global change applies live to every plugin without an
override. The global write rides the same request names (`plugin.limits.set { global: true }`, so the host-only rule
covers it unchanged) and its settings channel `plugins.globalLimits.set` has the per-plugin write's rule (`adapted`: a
browser only in server mode). Uninstalling a plugin leaves the global values.

## 7. Security, failures, testing, rollout

Rules (for CLAUDE.md's implementation patterns):
- main is the only authority: identity from the caller's tab token or the host's own plugin, never a payload; a plugin
  acts only on its own rooms in its own window.
- No pulling tabs in: a member is a tab the plugin opened into the room or a tab that ran an invite itself.
- Pull only: hooks and the gate carry a fixed pointer, never room text; room text enters a session only through that
  session's own `ccc room read`, fenced with a nonce; the core skill says it is never the person and grants nothing.
- A typed tab gets nothing without the person's mark; the mark is on at every join (main's constant, revision 3: a
  deliberate loosening, §2), bound to (tab, room) and held by the draft bit.
- Changing the mark, Pause, Resume and Remove are the person's; no plugin or hook path.
- Docs: no paths out of the store, no links (`O_NOFOLLOW` + `fstat`), caps, refused equals missing.
- Not a boundary: tabs run as the person's OS user. The rules prevent mistakes and make an injected tab's reach through
  a room advisory text behind a pointer, not the person's voice; the docs say so.

Failures: main down or a slow Stop reply means nothing printed and the messages stay queued; a block whose connection
closes unacked is applied as a plain Stop; an acked block whose print failed is a tab left working until its next hook; the person closing a member's tab removes it, its queue is dropped with a log line and the coordinator is
told; a quit or window close keeps membership; a disabled or removed plugin ends its rooms and the docs stay; a restart
reloads rooms paused and rematches members from the tab records.

Testing: unit tests with fakes for the registry and membership, invite expiry, the saved membership across a restore,
each delivery path (Stop pointer, gate pointer, badge), the blocked-Stop status and gate rule, the ack, the per-tab
block cap and the auto-pause, the mark binding (on at every join, kept across a restore) and the draft bit, the fence nonce, every doc rule (links, `..`, caps,
refused equals missing), the send caps and their overrides, persistence; grep tests (the mark changed only from the
shell page, the join's initial value a constant; hook output only from the Stop pointer and the existing SessionStart print); the fake `claude` emulates
`decision: block`, `stop_hook_active` and the cap of 8; e2e: a plugin opens two tabs that exchange a message and a doc,
and one Stop pointer through the real `ccc` start (the budget); drift tests for the guide and the core skill.

Rollout: branch `feat/rooms` (worktree `.claude/worktrees/groups`, based on `integration/editor-split`), a plan in
`docs/plans/`, run with `planning:exec`, reviewed, merged into the release branch. `bronos.team` is rebuilt on
`ctx.rooms` afterwards, outside the app release.
