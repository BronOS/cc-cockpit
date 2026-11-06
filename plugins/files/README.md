# Files (cockpit.files)

A tree of the project folder in a panel (left zone), shipped with cc-cockpit. Open any file of the
project, changed or not, to read it, attach notes and discuss it with Claude.

- Click a file (or Enter): opens it through "Plugin used to open files" (Settings > Plugins), the
  reviewer by default. Edit (hover, or `e`) opens it in the editor (micro by default).
- Everything is shown, dotfiles and git-ignored files too (ignored ones dimmed); `.git` never is.
  App settings: Hide hidden files, Hide ignored files.
- Git marks: M modified, A added, ? untracked, R renamed, U conflict; a dot on a folder with a change.
- Filter box (`/`): every word must appear in the path; searches git's tracked and untracked files
  (not ignored ones), or up to 20,000 files outside git.
- Right-click menu (also the context-menu key and Shift+F10): on a file Open, Open with default app,
  Reveal in Finder (Show in Explorer, Open in file manager), Ask Claude about this file, Copy path,
  Copy relative path, Rename…, Move to Trash; on a folder Reveal, New file…, New folder…, the copies,
  Rename…, Move to Trash; on the empty area New file…, New folder…, Reveal, Copy path. Move to Trash
  asks first (the app's dialog); Open with default app refuses scripts and programs.
- Keys: arrows, Right/Left expand and collapse, Enter open, `e` edit, F2 rename, `/` filter, Esc clear.
- Open folders are watched and remembered per project.

Design: `docs/design.md`. Tests: `node --test plugins/files/test/` (part of `npm run test:plugins`).
