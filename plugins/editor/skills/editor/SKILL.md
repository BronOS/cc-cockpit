---
name: editor
description: Point the user at code in cc-cockpit's editor by opening a file at a line (and column) in an editor tab. Use when you say "see line 42 of foo.ts", show where a change or a bug is, or want the user to look at a spot in a file.
---

# Editor

cc-cockpit has a code editor in its tab bar. Instead of only writing "src/a.ts line 42" in your answer,
open the spot for the user:

- `ccc edit <file>` opens the file in an editor tab.
- `ccc edit <file>:<line>` opens it at a line, `ccc edit <file>:<line>:<col>` at a line and column
  (both count from 1). `ccc edit <file> <line>` works too. Those are the only forms: no ranges
  (`a.ts:12-20`) and no `#L12`; give the first line of a range.

Rules:

- The file must be an existing text file inside the project folder (a relative path resolves against
  the current directory). A path outside it, a missing file or a binary file is refused (exit 1).
- It never takes the screen from the user: the tab opens marked with a dot, and the user selects it when
  ready. If the file is already open, its cursor moves to the line and its tab gets the dot again (unless
  the user is looking at it). Do not repeat the command to get attention.
- Open only the spot you are talking about, not every file you touched: several tabs open at once are noise.
- You change the file with your own tools; an open tab picks the change up (the user's unsaved text is merged).
- Works only inside a cc-cockpit tab, and needs the Editor plugin.
