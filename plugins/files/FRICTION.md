# Friction: what the file tree hit in the plugin API

- **Open a file through the person's pick** (fixed in the same change): only the Sessions panel
  click went through "Plugin used to open files"; a plugin could only call a service of a plugin it
  chose itself, ignoring the pick and never reaching the built-in viewer. Now `ctx.files.open`.
- **No clipboard in a panel** (worked around, 0.2.0): the sandboxed frame has an opaque origin, so
  `navigator.clipboard` is refused, and the host has no `ctx.clipboard`. `document.execCommand('copy')`
  from a hidden textarea inside the click does write it (Chromium allows it with the click's user
  activation), so Copy path and Copy relative path ship that way, with no new API. It only works
  inside the event handler: a copy after a round trip to the host would be refused.
- **No file-manager actions** (fixed in 0.2.0): reveal, open with the default app and the Trash need
  the desktop session the host's env does not have (`xdg-open`, `gio trash` fail on Linux). Now
  `ctx.files.reveal`, `openWithSystem` and `trash` (main checks the path, refuses runnable files,
  asks the person before the Trash).
- **No shell tab** (open): the public API opens Claude tabs (`ctx.sessions.open`) but not a shell
  tab, so the folder menu has no "Open terminal here". A terminal overlay (`ctx.overlay.open` kind
  `terminal`) is not a tab, and a privileged path for the bundled plugin is ruled out.
- **Forms do not submit in a panel** (noted): the frame is `sandbox="allow-scripts"` without
  `allow-forms`, so a `<form>`'s submit event never fires; the name bar handles Enter itself.
- **No "panel shown" event** (open): the page asks for a fresh tree when it loads, and folders are
  watched while expanded, but a host cannot tell whether its panel is visible, so watchers run
  while the panel is hidden too (bounded: 200).
- **No way to put text in a Claude prompt without sending it** (open): `ctx.sessions.send` always
  presses Enter, so "mention this file in the current tab" has no API. Discussing a file goes
  through the reviewer instead.
