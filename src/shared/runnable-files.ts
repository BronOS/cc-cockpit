// What `ctx.files.openWithSystem` refuses: files the system would RUN rather than show when handed to
// the default app (shell.openPath is a double click in Finder, Explorer or the Linux file manager).
// A plugin is trusted code, but this call exists so a person can open a document of their project
// in the app they use for it; a project is often a repo cloned from someone else, and a click on
// "Open with default app" must never start a program out of it. Running things is what tabs and
// `ctx.exec` are for, where the person (or the plugin, visibly) chooses to.
//
// One list for every platform: a repo carries files of all of them, a `.desktop` file on a Mac is
// harmless to refuse, and a per-platform list would let a file through on the platform nobody
// tested. Matched on the last extension, case-insensitively (`RUN.SH`, `Setup.EXE`: Windows and a
// default macOS volume do not care about case, and neither do the handlers). Besides this list main
// refuses folders (reveal them instead), any file with an exec bit (macOS opens an extensionless +x
// file in Terminal and runs it) and anything inside a `.app` bundle (RUNNABLE_BUNDLE_SUFFIX). Pure
// data and string work: main uses it, and the guide quotes it.

/**
 * Extensions (lower case, with the dot) whose default handler runs the file. Grouped by the system
 * that runs them; a few beyond the obvious ones are here for the same reason: `.fileloc` / `.url`
 * point the system at another file (a local program), `.com` / `.pif` / `.hta` / `.wsf` / `.vbe` /
 * `.jse` / `.cpl` are Windows' other runnable kinds.
 */
export const RUNNABLE_EXTENSIONS: readonly string[] = Object.freeze([
  // macOS: Terminal runs these, Automator runs workflows and actions, Finder follows a .fileloc.
  '.command',
  '.tool',
  '.terminal',
  '.workflow',
  '.action',
  '.fileloc',
  // Shell scripts (a desktop may hand them to a terminal).
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  // Linux: launchers and self-running images.
  '.desktop',
  '.appimage',
  // Windows: programs, scripts for the Windows Script Host (.js and .vbs run, not edit, on a
  // double click), installers, shortcuts and screen savers.
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.ps1',
  '.lnk',
  '.url',
  '.pif',
  '.msi',
  '.scr',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.hta',
  '.cpl',
  // Java: a double click runs a jar wherever a JRE is installed.
  '.jar'
])

/** A path segment with this suffix (any case) is a macOS app bundle: it and everything inside it runs. */
export const RUNNABLE_BUNDLE_SUFFIX = '.app'

/** The last extension of a file name, lower case with the dot; '' for none (`Makefile`, `.env`). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file's name, not an extension (`.bashrc` is not a `.bashrc` file).
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Why `path` must not be opened with the system's default app, by its name alone, or null. `path`
 * may use `/` or `\` separators (a project-relative path, or a real path on Windows). The checks
 * that need the file itself (a folder, the exec bit) are main's.
 */
export function runnableByName(path: string): string | null {
  const segments = path.split(/[\\/]/).filter((s) => s !== '')
  const name = segments[segments.length - 1] ?? ''
  if (segments.some((s) => s.toLowerCase().endsWith(RUNNABLE_BUNDLE_SUFFIX) && s.length > RUNNABLE_BUNDLE_SUFFIX.length)) {
    return 'it is an app bundle or inside one'
  }
  const ext = extensionOf(name)
  if (ext !== '' && RUNNABLE_EXTENSIONS.includes(ext)) return `a ${ext} file runs when opened`
  return null
}
