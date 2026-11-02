// The argv of the terminal overlay a Sessions panel file click opens (design §3: "a file click
// opens it in an overlay"). Pure apart from one injected probe, so vitest drives it with a fake
// and nothing here spawns a process or imports Electron.
//
//   tracked file          git diff -- <file>
//   untracked file        git diff --no-index -- /dev/null <file>
//   outside any repo      less -- <file>
// (each git call also carries the global flags in GIT_FLAGS, and less gets `-+F`; see there).
//
// `file` is a path a Claude hook reported for the tab: text a model produced, so it can start
// with `-` or hold spaces and newlines. It is resolved to an absolute path first (an absolute
// path never begins with `-`) and every command also gets `--`, so neither git nor less can read
// it as an option. Exec is argv-only; nothing goes through a shell.
//
// Known gaps (phase 1: the probe's exit code is all we look at):
//   - a file inside a nested repository the outer one does not track exits 1, so it shows as an
//     all-added file instead of its own repository's diff;
//   - an untracked file deleted after Claude touched it also exits 1, and `diff --no-index` on
//     the missing path only prints an error (the pager keeps the overlay up on an empty screen);
//     a deleted TRACKED file is still in the index (exit 0) and shows as a deletion;
//   - a file inside a registered submodule exits 128 and is shown with less, not diffed.
import { resolve } from 'node:path'

/**
 * What `git --literal-pathspecs ls-files --error-unmatch -- <file>` ended in, run in the tab's cwd. `spawnFailed`
 * covers a missing git binary. The probe is injected: main passes an execFile wrapper.
 */
export interface LsFilesResult {
  code: number | null
  spawnFailed?: boolean
}
export type LsFiles = (argv: string[], cwd: string) => Promise<LsFilesResult>

/**
 * Global flags for the diff calls, before the subcommand (after `--` they would be paths).
 *   --literal-pathspecs  `--` stops options but not pathspec magic: `app/[id]/page.tsx` (a very
 *                        common Next.js name) is a glob there, so `git diff` could show several
 *                        files. The probe gets it too (lsFilesArgv), or it could answer for a
 *                        different tracked file that the glob matches.
 *   core.pager=...       the overlay closes when its program exits, and git's default pager env
 *                        (LESS=FRX when LESS is unset) quits at once on output that fits one
 *                        screen: the usual small Claude edit, an empty diff (change already
 *                        committed) or a short new file flashed and was gone. `-+F` turns
 *                        quit-if-one-screen off even when the user's LESS has F. git runs the
 *                        pager through `sh -c`, but the value is a constant with no reported text.
 *   --paginate           page even when the user's `pager.diff` is false or names another
 *                        program. GIT_PAGER in their env still wins over core.pager: their choice.
 */
export const GIT_DIFF_FLAGS: readonly string[] = ['--literal-pathspecs', '-c', 'core.pager=less -R -+F', '--paginate']

/** The probe's argv. `--error-unmatch`: exit 1 when the pathspec matches no tracked file. */
export function lsFilesArgv(file: string): string[] {
  // Literal pathspec only (see GIT_DIFF_FLAGS); nobody reads the probe's output, so no pager.
  return ['git', '--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file]
}

/**
 * Choose the argv that shows `file` (as reported for a tab whose working directory is `cwd`).
 *   exit 0     tracked in the repo containing cwd: `git diff`
 *   exit 1     in a repo and not tracked (new file Claude wrote): `git diff --no-index`
 *   anything else (128: not a repository, or the path lies outside the repository; git missing):
 *              `less`, which shows the file as it is
 */
export async function diffArgv(file: string, cwd: string, lsFiles: LsFiles): Promise<string[]> {
  const abs = resolve(cwd, file)
  const probe = await lsFiles(lsFilesArgv(abs), cwd).catch((): LsFilesResult => ({ code: null, spawnFailed: true }))
  // `-+F`: a user's LESS=F would close a one-screen file's overlay at once (see GIT_DIFF_FLAGS).
  const less = ['less', '-+F', '--', abs]
  if (probe.spawnFailed) return less
  if (probe.code === 0) return ['git', ...GIT_DIFF_FLAGS, 'diff', '--', abs]
  if (probe.code === 1) return ['git', ...GIT_DIFF_FLAGS, 'diff', '--no-index', '--', '/dev/null', abs]
  return less
}
