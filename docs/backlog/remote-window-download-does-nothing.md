---
worth: yes
where: src/main/remote/remote-windows.ts:112
added: 2026-11-19
---
# download in a remote window does nothing on the desktop

Reported by Oleg: in the desktop's remote window (a server opened through Remote servers), Files › Download on a
file shows nothing, while the server side was checked and does send the file. Expected: the file lands in the
desktop's Downloads folder and a notice says so (Show in Finder).

Where to look first, in the order the window's gates run (design-download.md §3.3, comment at the `where` line):
- the origin gate cancels with a log line only and no notice: anything not `<current server origin>/d/<token>` with
  a one-entry URL chain (a redirect, another origin, e.g. a tunnel or SSH loopback port the page and the link
  disagree on) is dropped silently by design. Main's log says which.
- the click gate (`DOWNLOAD_CLICK_MS`) and the burst budget refuse with a native notice; if macOS notifications are
  off for the app, those refusals and the saved notice are invisible too, and the file may already be in Downloads.
- the save (`remote-downloads.ts`): the macOS no-hard-link refusal, the temp `.cc-download-*` then the exclusive
  link.

Unknown: which connection kind (built-in SSH, My own tunnel, Direct) and whether the build was packaged; CLAUDE.md
lists remote downloads as never run on a packaged Mac. First step: reproduce, then read main's log line for that
click and check `~/Downloads`.
