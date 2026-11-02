// "Install `ccc` command" (Settings > Appearance and keys): a symlink `~/.local/bin/ccc` to the
// generated wrapper `<data>/bin/ccc`, so the CLI works from any terminal, not only from the app's
// own tabs (whose PATH already has `<data>/bin`, pty-env.ts). Pure Node over the real fs: unit
// tests give it a temp HOME. main calls it, never the renderer (the renderer only asks).
//
// Decisions:
//  - The link points at the wrapper, not at the Electron binary or out/cli: the wrapper is rewritten
//    at every start, so an app update or a move never leaves the link pointing at a stale path, and
//    a missing app makes the wrapper exit 0 (the hook invariant) instead of a "command not found".
//  - Only a symlink that already points at THIS data dir's wrapper counts as ours. Anything else at
//    that path (a file, a directory, a link to another tool or to another data dir's wrapper) is
//    refused and reported, never replaced: ~/.local/bin is shared with the user's own tools.
//  - `symlink(2)` itself refuses an existing path (EEXIST), so there is no check-then-overwrite
//    window; a link created by someone between our `lstat` and `symlink` is still not clobbered.
//  - Whether `~/.local/bin` is on the PATH is read from the login-shell environment main captured
//    (login-env.ts), not from the GUI app's own minimal PATH, which would always say no.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { CccCommandState, CccCommandView } from '../../shared/ipc'

export interface CccInstallDeps {
  home: string
  /** `<data>/bin/ccc`. */
  wrapperPath: string
  /** The login-shell PATH, when main has captured it. */
  loginPath: () => string | undefined
  /** AppSettings.cccOffer with the default applied; the view carries it for the Settings checkbox. */
  offerAtStart?: () => boolean
}

export class CccCommandInstaller {
  constructor(private readonly deps: CccInstallDeps) {}

  private get binDir(): string {
    return join(this.deps.home, '.local', 'bin')
  }

  private get linkPath(): string {
    return join(this.binDir, 'ccc')
  }

  view(): CccCommandView {
    const binDir = this.binDir
    return {
      state: this.state(),
      linkPath: this.linkPath,
      target: this.deps.wrapperPath,
      binDir,
      // An empty PATH entry means "cwd", not ~/.local/bin, but resolve('') would say cwd: skip it.
      offerAtStart: this.deps.offerAtStart?.() ?? true,
      onPath: (this.deps.loginPath() ?? '').split(delimiter).some((entry) => entry !== '' && resolve(entry) === binDir)
    }
  }

  /**
   * Create `~/.local/bin` if needed and link `ccc` to the wrapper. Idempotent for our own link;
   * throws (with a message the page shows) for anything else already at the path.
   */
  install(): CccCommandView {
    const state = this.state()
    if (state === 'foreign') {
      throw new Error(`${this.linkPath} already exists and is not the ccc link of this app; remove it yourself to replace it`)
    }
    if (state === 'missing') {
      mkdirSync(this.binDir, { recursive: true })
      try {
        symlinkSync(this.deps.wrapperPath, this.linkPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        // Lost a race with whoever created it: fine only if what they made is our link.
        if (this.state() !== 'installed') {
          throw new Error(`${this.linkPath} appeared meanwhile and is not the ccc link of this app`, { cause: err })
        }
      }
    }
    return this.view()
  }

  /** What is at the link path (throws when it cannot be inspected). */
  state(): CccCommandState {
    try {
      // lstat: a dangling or foreign symlink is "something there" too; stat would follow it.
      if (!lstatSync(this.linkPath).isSymbolicLink()) return 'foreign'
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      // ENOTDIR (~/.local is a file), EACCES...: nothing is known to sit at the path, so "already
      // something else" would be false. Report the real cause (the page shows the message).
      throw new Error(`cannot inspect ${this.linkPath}: ${(err as Error).message}`, { cause: err })
    }
    try {
      return readlinkSync(this.linkPath) === this.deps.wrapperPath ? 'installed' : 'foreign'
    } catch {
      return 'foreign'
    }
  }
}
