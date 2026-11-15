# Room caps as plugin limits

External review: auto

## Overview
- Make two fixed Rooms caps the person's setting, like the existing plugin limits (global value plus per-plugin
  override, hard ceiling): `roomsPerProject` (today `MAX_ROOMS_PER_PLUGIN` = 5) and `membersPerRoom` (today
  `MAX_MEMBERS_PER_ROOM` = 20). Asked for by the team plugin design (`~/Projects/cc-cockpit-team/docs/design.md` §6):
  as much flexibility for the user as possible.
- Fix the doc drift: the SDK comments still point only to "Settings > Plugins > Limits".
- Storage caps stay fixed (ended rooms kept, invites, waiting messages, doc and room sizes): they protect the app.

## Context (from discovery)
- `src/shared/plugin-limits.ts` (`PLUGIN_LIMIT_SPECS`: key, label, default, ceiling), `src/main/plugins/plugin-limits.ts`
  (global `pluginLimitsGlobal` + per-plugin overrides in `app.json`, clamped, resolved on every call).
- `src/main/rooms/room-registry.ts:24,34` (`MAX_ROOMS_PER_PLUGIN`, `MAX_MEMBERS_PER_ROOM`; create at :210, open and
  join where members are added); `src/main/rooms/room-service.ts` already reads the send caps from the limits store.
- UI: `src/renderer/settings/LimitsForm.tsx` (shared by Settings > General "Plugin limits" and a plugin's Limits),
  `GeneralPage.tsx:266`. CLI: `formatPluginLimits`, `ccc plugin limits`.
- Docs: `src/sdk/types.ts:1117,1199` (rooms caps and the send caps), `src/cli/guide/api.md`, `cli.md`,
  `docs/features.md` ("Per-plugin limits", Rooms "Limits"), `docs/design-rooms.md` §1 and §6; the example's types copy.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests**, success and error cases
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Work in a worktree on a branch off `master` (another Claude may use the main checkout).

## Testing Strategy
- **unit tests**: vitest (`npm test`), the limits store, the room registry caps, the CLI format, drift tests.
- **e2e tests**: `test/e2e/rooms.spec.ts`, `rooms-view.spec.ts`, `rooms-strip.spec.ts`, `settings-plugins.spec.ts`,
  `settings-page.spec.ts`, `web-access-settings.spec.ts` (`npx playwright test` on those after `npm run build`).
- unit tests touching limits beyond the obvious: `cli-guide.test.ts`, `host-api.test.ts`, `plugin-list-model.test.ts`.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix

## Solution Overview
- Two more entries in `PLUGIN_LIMIT_SPECS`; everything generic over the specs (store, IPC, LimitsForm, CLI) picks
  them up. The room registry takes a `caps(pluginId)` lookup instead of the constants and reads it on every create,
  `open` and `join`.
- Lowering a cap never evicts: existing rooms and members stay; only new creates and joins are refused, and the error
  names the cap and where to change it.

## Technical Details
- `roomsPerProject`: default 5, ceiling 20, label "rooms open at once in a project (rooms.create)".
- `membersPerRoom`: default 20, ceiling 50, label "members in one room (rooms.open, ccc room join)".
- No unit field: `formatPluginLimits` and `LimitsForm` print only the free-text `label`, so the labels carry the unit.
  Texts that say every cap is per minute get fixed: the `shared/plugin-limits.ts` header ("Every cap counts over one
  minute"), the `MAX_PLUGIN_LIMIT_EDITS` comment ("four caps"), GeneralPage.tsx:265 ("How much a plugin may do a minute").
- Enforcement points (room-registry.ts on origin/master): `create` (:210, rooms) and `checkJoin` (:646, members), which
  serves `addMember`, `checkAdd` (the `ctx.rooms.open` pre-check) and `redeem` (`ccc room join`), so one lookup there
  covers all three. `invite()` checks no seats: invites past the cap are refused at redeem (tested).
- **Restore must not use the cap**: `parseRoom` (:843) returns null for a room with more than `MAX_MEMBERS_PER_ROOM`
  members, so a room grown to 30 under a raised cap would be dropped on the next start. Parse against the ceiling (50)
  instead. The `MAX_ENDED_ROOMS_PER_PLUGIN` comment ("stays under this plus MAX_ROOMS_PER_PLUGIN") is updated.
- The limits lookup passed to the registry and service is typed `RoomSendLimits` today (room-service.ts:68,
  room-delivery.ts:113): widen it to the full `PluginLimits`.
- Refusal texts say the cap, where to change it, and that lowering it removes nothing.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: the app release that carries it.

## Implementation Steps

### Task 1: Two new limit keys [model: sonnet]

**Files:**
- Modify: `src/shared/plugin-limits.ts`, `src/main/plugins/plugin-limits.ts`
- Modify: `test/unit/plugin-limits*.test.ts`

- [x] add `roomsPerProject` and `membersPerRoom` to `PLUGIN_LIMIT_SPECS` with defaults, ceilings and labels that carry
      the unit; fix the "every cap is per minute" texts (header, `MAX_PLUGIN_LIMIT_EDITS` comment)
- [x] update `cli-guide.test.ts`'s hard-coded spec key list (:368); keep `MAX_ROOMS_PER_PLUGIN` / `MAX_MEMBERS_PER_ROOM`
      exported as the defaults' source (the test imports them)
- [x] global and per-plugin resolution, clamping and reset work for both (they should, generically: prove it)
- [x] write tests: resolution order, ceilings, a hand-edited value clamped, CLI format units
- [x] run tests - must pass before next task

### Task 2: Room registry reads the caps [model: opus]

**Files:**
- Modify: `src/main/rooms/room-registry.ts`, `src/main/rooms/room-service.ts`, `src/main/index.ts` (wiring)
- Modify: `test/unit/room-registry.test.ts`, `test/unit/room-service.test.ts`

- [x] widen the limits lookup type from `RoomSendLimits` to `PluginLimits`; `create` and `checkJoin` read it on every
      call (checkJoin covers addMember, checkAdd and redeem)
- [x] `parseRoom` checks members against the ceiling (50), never the current cap, so a room grown under a raised cap
      survives a restart; update the `MAX_ENDED_ROOMS_PER_PLUGIN` comment
- [x] lowering a cap never evicts or ends anything; new creates/joins over it are refused naming the cap and where to
      change it (Settings > General > Plugin limits, a plugin's Limits, `ccc plugin limits`)
- [x] restored rooms and members over a lowered cap restore as before (no refusal on restore)
- [x] write tests: raised cap allows more, lowered cap refuses new but keeps existing, restore of a room with more than
      20 members, an invite redeemed over the cap refused, per-plugin override vs global
- [x] run tests - must pass before next task

### Task 3: Settings pages and CLI show the new keys [model: sonnet]

**Files:**
- Modify: `src/renderer/settings/LimitsForm.tsx`, `src/renderer/settings/GeneralPage.tsx` (only if not generic)
- Modify: `test/e2e/settings-page.spec.ts` or `settings-plugins.spec.ts` (whichever covers Plugin limits)

- [x] both pages list the two keys with the right unit wording; `ccc plugin limits [--global]` prints and sets them
- [x] the General page's help text mentions rooms and members, not only rates
- [x] write/update tests: renderer unit tests if present; the settings e2e sets `membersPerRoom` globally
- [x] run tests - must pass before next task

### Task 4: Docs and drift [model: sonnet]

**Files:**
- Modify: `src/sdk/types.ts`, `examples/plugin/sdk/types.ts` (copy), `src/cli/guide/api.md`, `src/cli/guide/cli.md`,
  `docs/features.md`, `docs/design-rooms.md`

- [x] SDK comments for `rooms.create`, `rooms.open`, `sessions.send` and `rooms.send` name Settings > General > Plugin
      limits and a plugin's Limits; the caps described as defaults the person can change
- [x] guide and features: the two new keys with defaults and ceilings; design-rooms §1 and §6 a short note
- [x] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`; drift tests pass
- [x] run tests - must pass before next task

### Task 5: Verify acceptance criteria [model: sonnet]

- [x] verify both caps configurable globally and per plugin, enforced on create/open/join, never evicting
- [x] full suite once at the end: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:plugins`
- [x] `npm run build` leaves no diff in committed dist files
- [x] run the e2e specs listed in Testing Strategy

### Task 6: [Final] Update documentation [model: sonnet]

- [ ] CLAUDE.md only if a rule changes (the Rooms bullets name the caps)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

- Release with the next app version; the team plugin's README can then mention the configurable room caps.
