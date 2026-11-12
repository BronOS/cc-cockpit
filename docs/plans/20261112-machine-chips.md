# Other machines in the sessions strip

## Overview
- Local and remote windows run different cockpits, so the top bar's sessions strip of each shows only its own machine.
  Decided with the user: one chip per machine (design `docs/design-remote-desktop.md` §4.1).
- Local windows get one chip per connected server (name, waiting / working counts, dimmed when unreachable; click
  focuses that server's last remote window). Remote windows get a "This computer" chip (click focuses the last local
  window, else the picker).

## Context (from discovery)
- Strip: `plugins/sessions` (`slots/strip.html`, `slots/strip.js`, `dist/host.js`, `lib/`), bundled, public API only;
  `"access": { "sessions": "all-windows" }`.
- Plugin API: `src/sdk/types.ts` `ctx.sessions` (`list({scope:'all'})`, `onChange`, `focus`), host side
  `src/host/ctx/`, main side `src/main/plugins/host-api.ts` (access checks, rate limits), guide `src/cli/guide/*.md`
  (drift tests `cli-guide.test.ts`), example plugin types copy (`examples/plugin/sdk/types.ts`, CLAUDE.md).
- Gateway: `src/main/web/gateway.ts`, `PROJECTS_PATH` in `src/shared/web-protocol.ts`; session registry
  `src/main/sessions/session-registry.ts`.
- Remote: `src/main/remote/remote-windows.ts` (`ses.fetch` per partition, navigation interception incl. "Back to the
  picker"), `remote-service.ts`, `WindowManager` hooks; web client `src/renderer/web/main.tsx`, `shell-kind.ts`,
  `src/shared/remote-agent.ts` (desktop UA).

## Development Approach
- **testing approach**: Regular (code first, then tests); every task with tests, all passing before the next.
- A new `ctx` member needs its guide text and the example types copy in the same change (CLAUDE.md).
- Nothing but counts and a name crosses machines; machine ids are opaque and main-minted.
- Dense "why" comments.

## Testing Strategy
- unit: endpoint (signed in / out, counts, not server mode), poller (only while a window is open, 404 = no counts,
  failure = unreachable), host-api access and rate limit, strip rendering helpers, navigation interception.
- e2e: `remote-desktop.spec.ts` Direct: a local window's strip shows the server chip with counts and focuses the remote
  window; the remote window's "This computer" chip focuses the local window.

## Progress Tracking
- mark completed items with `[x]`; ➕ new tasks; ⚠️ blockers.

## Implementation Steps

### Task 1: Server: `GET /api/sessions` counts [model: opus]

**Files:**
- Modify: `src/shared/web-protocol.ts`, `src/main/web/gateway.ts` (and the module answering `/api/projects`), `src/main/index.ts` wiring
- Modify/Create: tests in `test/unit/` for the gateway route

- [x] `SESSIONS_PATH = '/api/sessions'`; GET only, server mode only (404 otherwise), signed-in device required (401
      as `/api/projects`), `no-store`; answers `{ waiting, working, idle }` over every Claude tab (status mapping from
      the registry's statuses, documented in a comment)
- [x] tests: signed in, signed out, desktop mode 404, counts from a fake registry, non-GET refused
- [x] run tests - must pass before next task
- ➕ The mapping is `src/main/web/session-counts.ts › countSessions` (a `Record` over `TabStatus`, so a new status fails
      the typecheck): `waiting` = waiting + needs-permission, `working` = working + starting, `idle` = idle + ended; the three
      add up to the server's Claude tabs. The gateway dep is `sessionCounts?: () => WebSessionCounts` (`web-protocol.ts`),
      passed by `index.ts` only when `server`; absent, the GET is 404 like an older server. The gateway rebuilds the three
      numbers (non-negative safe integers, else 0); a throwing source is a 500 with no text, never zeros. Tests at the end of
      `test/unit/web-gateway.test.ts` ("server mode: session counts", "countSessions").

### Task 2: Main: machine poller and `ctx.sessions.machines` [model: opus]

**Files:**
- Create: `src/main/remote/machine-status.ts`
- Modify: `src/main/remote/remote-service.ts` / `remote-windows.ts`, `src/main/plugins/host-api.ts`, `src/host/ctx/*`,
  `src/sdk/types.ts`, `examples/plugin/sdk/types.ts`, `src/cli/guide/*.md`, `src/main/index.ts`

- [x] poller: per server with a remote window open, `GET /api/sessions` through its partition at once and every 5 s;
      stops when its last window closes; 404 → reachable, no counts; failure → unreachable; emits on change only
- [x] `ctx.sessions.machines()`, `onMachinesChange(listener)`, `focusMachine(id)` (opaque per-server ids minted by
      main; `"all-windows"` access required; focus rate-limited like `focus`; focuses that server's most recently
      focused remote window)
- [x] guide text and example types copy; drift tests pass
- [x] tests: poller lifecycle and states; host-api access refused without the declaration; focus rate limit; unknown id
- [x] run tests - must pass before next task
- ➕ Final API for Task 3 (`src/sdk/types.ts`, guide `api` topic): `ctx.sessions.machines(): Promise<MachineInfo[]>`,
      `ctx.sessions.onMachinesChange(listener: (machines: MachineInfo[]) => void): Disposer`,
      `ctx.sessions.focusMachine(id: string): Promise<boolean>`; `MachineInfo = { id, name, reachable, waiting?, working?,
      idle? }`. The counts are ABSENT (not 0) before the first answer, for an old server (404) and whenever `reachable` is
      false, so the chip draws the name alone then, dimmed only when `!reachable`. All three throw without the
      `access` declaration (the strip has it). The event `sessions.machines { machines }` goes only on a change, only to
      hosts running a declaring plugin; `onMachinesChange` does not call back with the current list, so read `machines()`
      once at start. `focusMachine` shares `focus`'s budget (10 in 10 s per plugin); false for an id no longer listed.
      Feature check: `typeof ctx.sessions.machines === 'function'`.
- ➕ Ids: `m-<12 base64url chars>` minted by `MachineStatus` once per server per run (kept across a close and reopen in the
      run), never the saved server id (the `remote.*` channels' record key and the partition's name). Order = the order the
      servers' first windows opened (`RemoteWindows.serverIds`).
- ➕ Poller (`src/main/remote/machine-status.ts`): a machine is listed at once (reachable, no counts) when its first window
      opens; asks again `POLL_MS` (5 s) after each answer, never two at once; 404 → reachable, no counts; a 200 that is not
      three counts (0..100000) → the same; anything else (no answer, 401, 5xx) → unreachable, counts dropped, logged once
      per change. `index.ts` calls `sync()` from RemoteWindows' `onChanged` and `refresh()` on a rename (`refreshTitles`),
      `dispose()` at quit. `fetchJson` now rejects with `RemoteHttpError { status }` (`remote-windows.ts`).
- ➕ For Task 4: `RemoteWindows` now tracks focus (`RemoteWindowHooks.focused`, wired to the BrowserWindow's `focus` event in
      `electron-remote-window.ts`) and has `focusServer(serverId)` (most recently focused, a new window counts as focused).
      Nothing tracks the most recently focused LOCAL project window yet; Task 4 needs its own (WindowManager / the `focus`
      handler in `index.ts`). The Plugins page's access line now also names the servers' counts (`PluginsPage.tsx`).

### Task 3: Strip: one chip per server [model: sonnet]

**Files:**
- Modify: `plugins/sessions/slots/strip.js`, `strip.html`, `plugins/sessions/src` or `lib` as the plugin is laid out,
  its `test/`, and `dist/` if it is built

- [x] chips after the session chips: name, waiting / working marks as the strip draws them for a session, dimmed when
      unreachable, tooltip with the counts; click → `focusMachine`; feature-checked (`typeof ctx.sessions.machines`)
- [x] plugin tests (`npm run test:plugins`); checked against `ccc guide style`
- [x] run tests - must pass before next task

### Task 4: Remote window: "This computer" chip [model: opus]

**Files:**
- Modify: `src/renderer/web/main.tsx` (or the top bar component), `src/renderer/shell-kind.ts`,
  `src/main/remote/remote-windows.ts`, `src/main/index.ts` (focus last local window), `src/renderer` styles

- [x] web client: with the desktop UA, a "This computer" chip at the start of the strip area; click →
      `location.assign('/?cc-desktop=local')`
- [x] main: a remote window's navigation to `?cc-desktop=local` (any page) is cancelled and focuses the most recently
      focused local project window, else shows the picker; nothing else is read from the URL
- [x] tests: interception (focus local / picker), other navigations untouched; web client helper
- [x] run tests - must pass before next task

### Task 5: e2e and docs [model: sonnet]
- [ ] extend `test/e2e/remote-desktop.spec.ts` (Direct, `CC_COCKPIT_NO_BUNDLED: ''` for the strip): server chip with
      counts in the local window, click focuses the remote window; "This computer" in the remote window focuses the
      local one
- [ ] `docs/features.md` ("Remote servers" and the Sessions strip), README if it lists the strip
- [ ] run `npm run typecheck && npm run lint && npm test && npm run test:plugins` and the remote-desktop e2e

### Task 6: Verify and finish [model: sonnet]
- [ ] full e2e run; known Hyprland failures only
- [ ] CLAUDE.md Remote servers bullet: one line on machine chips (counts only, opaque ids)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
- Manual: a real server over SSH; the counts update while a Claude tab there works and waits.
