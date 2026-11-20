---
worth: yes
where: src/main/web/settings.ts:39
added: 2026-11-20
---
# web access on by default, listening on this computer only

Oleg, 2026-11-20, for the next release: "web access config has to be On by default and pointed on localhost
(127.0.0.1). I mean listening on localhost". Today `DEFAULT_WEB_ACCESS.enabled` is `false` and `webAccessOf` reads an
absent `enabled` as off, so a fresh install has no browser access and no **Share** button (guests need web access on);
the bind already defaults to `127.0.0.1` and the sign-in mode to Access link.

What the change touches:
- `webAccessOf`: an absent `enabled` reads as on; a stored `false` (the person turned it off) stays off. Installs that
  never touched web access therefore turn on at the update; say so in the release notes.
- Bind stays `DEFAULT_WEB_BIND` (`127.0.0.1`), mode stays `link`: nothing reachable from the network, and a browser on
  this Mac still needs the access link (the gateway's Host, Origin and secret checks are always on, design-web.md §4.1).
- A taken port (7330 already in use, a second data dir, a server on the same Mac) must leave the desktop running with
  web access in its "failed" state, never block start: check the desktop path, not only server mode's exit.
- Tests: every launched app (e2e `launchCockpit`, unit fixtures that build settings) must keep web access off unless
  a spec turns it on, or parallel test apps fight over 7330; `web-fixtures.ts` and `server-fixtures.ts` already set it.
- Docs: design-web.md §4 "Off by default" → on, loopback only, with the reason; features.md "Web access"; the Settings
  page text if it says off by default.
