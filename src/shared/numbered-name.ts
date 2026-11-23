// The one numbering rule for a name that is taken: the remote window's save into Downloads
// (`main/remote/remote-downloads.ts`) and an upload's Keep both and in-upload dedupe
// (`shared/uploads.ts`, design-upload.md §2.2-2.3) number the same way, so the person sees one
// pattern whichever way a file arrived. No imports: the renderer bundles it too.

/** Numbered names tried after the plain one: `name (1).ext` up to this. */
export const MAX_NAME_NUMBER = 99

/**
 * `name` with ` (n)` before its last extension (`report (1).pdf`, `notes (2)`, `a.tar (1).gz`); n = 0
 * is the name itself. A leading dot is not an extension's: `.env` becomes `.env (1)`, never ` (1).env`
 * (which would turn a dot file into a visible one with an odd name).
 */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}
