# Friction: what the file tree hit in the plugin API

- **Open a file through the person's pick** (fixed in the same change): only the Sessions panel
  click went through "Plugin used to open files"; a plugin could only call a service of a plugin it
  chose itself, ignoring the pick and never reaching the built-in viewer. Now `ctx.files.open`.
- **No clipboard in a panel** (open): the sandboxed frame has an opaque origin, so
  `navigator.clipboard` is refused, and the host has no `ctx.clipboard`. "Copy path" is left out.
  `ctx.exec` of `pbcopy` / `wl-copy` would work but is platform-specific.
- **No "panel shown" event** (open): the page asks for a fresh tree when it loads, and folders are
  watched while expanded, but a host cannot tell whether its panel is visible, so watchers run
  while the panel is hidden too (bounded: 200).
- **No way to put text in a Claude prompt without sending it** (open): `ctx.sessions.send` always
  presses Enter, so "mention this file in the current tab" has no API. Discussing a file goes
  through the reviewer instead.
