---
worth: later
where: src/main/webview/electron-offscreen-webview.ts:224
added: 2026-11-20
---
# off-screen pages: a crash on a core-dumping Linux host holds the page and its input about 40 s

The hung-page watchdog (`hung-navigation.ts`, branch `backlog/hung-page-watchdog`) covers a page that spins: a reload,
load, back or forward that stalls while the page answers no probe gets its renderer SIGKILLed and goes again. What it
does not cover: a renderer that really crashes on a Linux host whose `core_pattern` pipes to systemd-coredump (Debian,
`ulimit -c` unlimited) sits in `do_exit` writing its core for 42 to 46 s before `render-process-gone` fires (Debian VM
10.0.20.115, Electron 45.1.0, 2026-11-20; `coredumpctl` lists the SIGTRAP dumps). Meanwhile `getOSProcessId` is
unchanged, nothing else fires, and the input router keeps what the person types parked (its reset waits for the event);
then the manager drops the view and the panel shows no page until it navigates again. A reload in that window is the
watchdog's: its SIGKILL ends the dump at once (gone 4 ms later), so the page comes back. With no navigation, nothing
does. macOS is not affected (the crash is gone at once). A fix would need a sign of the crash before the event (the
renderer's state, a probe on input that stalls), or a reload of its own; `forcefullyCrashRenderer` (test runs only) shows it.
