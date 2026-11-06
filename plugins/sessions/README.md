# Sessions (cockpit.sessions)

The Claude status view, shipped with cc-cockpit and built on the public plugin API only
(`docs/design-next.md` §4.2).

- Panel **Sessions** (left zone): a card per Claude tab of this window with its name or topic, the
  gist (or the last prompt), status, notes, steps and changed files. A card click selects the tab; a
  file click opens it (the project's "Plugin used to open files", else the built-in viewer). The
  header says how many sessions the window has. Flagged tabs (the person's `SessionInfo.flag`) are
  listed first under "Flagged", each card edged in its colour with the note.
- Slot **sessions-strip** in the top bar: the Claude tabs of the other windows, the ones that need you
  first and tinted, with their project's colour and, for a flagged tab, a bar in the flag's colour
  (the note stays in its window). A click raises that window at the tab. Nothing is
  drawn when no other window has a session.
- App setting: Changed files shown per session (1-500, default 10).
- Declares `"access": { "sessions": "all-windows" }`: it sees status, tool, title, name and project of
  other windows' tabs, never their prompts, notes, files or terminal.

Turn it off (in a project or in all of them) to use another plugin's panel; another plugin can draw
the strip through the `sessions-strip` pick. Without either the tab strip's dots, `ccc sessions` and
notifications still work.

Tests: `node --test plugins/sessions/test/` (part of `npm run test:plugins`).
