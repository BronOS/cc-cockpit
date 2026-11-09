// `ccc` CLI entry, run as Node by the generated <data>/bin/ccc wrapper.
// The invariant of this process: it never fails a Claude hook (CLAUDE.md), so `hook` always exits
// 0, whatever happens in client.ts. The user commands (Task 21) exit 0 too when the app is not
// there; they are non-zero only for a usage error (2), a request main refused (1) or a crash (1).
// The hard cap below is a backstop for a bug that would hang past the 500 ms budget `runHook`
// enforces itself.
//
// No static imports here, on purpose (Task 13 review). The bundler hoists every chunk `require`
// to line 1 of out/cli/index.js, and client.ts shares a hashed chunk with main
// (out/chunks/transport-<hash>.js). A dev rebuild (`emptyOutDir`) or a partial out/ makes that
// require throw before any handler exists: Electron-as-Node then prints a stack and exits 1, a
// failed hook in the user's Claude session. So the handlers go in first and the client is loaded
// with a dynamic import, whose failure is a rejection that ends in exit 0 like everything else.
//
// Only `hook` swallows a crash. A user command (`ccc overlay`, `open`, `sessions`) that crashes
// exits 1 with the message, so a script never reads a crash as success.
// `statusline` (cli/statusline.ts) is Claude Code's status line command, run after every message:
// it must never fail either, and is quiet on a crash like a hook. Only the exact call hooks.json
// makes (`statusline` and nothing after it); anything else goes through the parser like any word.
const statusline = process.argv[2] === 'statusline' && process.argv.length === 3
const hook = process.argv[2] === 'hook' || statusline
const exitQuietly = (): never => process.exit(0)

/**
 * Exit once everything queued on stdout AND stderr has been written. process.exit() right after a
 * write truncates piped output (a pipe's write is async on this platform: ~512 bytes survived of
 * 20000 on stdout; a plugin command's 200,000-byte stderr arrived as 65,536 bytes when only stdout
 * was waited for). An empty write's callback runs after the writes queued before it. A stream
 * that is closed or broken (EPIPE: the reader went away) may never call back, so its error ends
 * the wait too; nothing would read the rest anyway.
 */
function exitFlushed(code: number): void {
  let pending = 2
  const done = (): void => {
    if (--pending === 0) process.exit(code)
  }
  for (const stream of [process.stdout, process.stderr]) {
    let called = false
    const once = (): void => {
      if (called) return
      called = true
      done()
    }
    stream.once('error', once)
    if (stream.destroyed || !stream.writable) once()
    else stream.write('', once)
  }
}

const crashed = hook
  ? exitQuietly
  : (err: unknown): void => {
      // errorText inlined: a static import is exactly what this file must not have (see above).
      process.stderr.write(`ccc: ${err instanceof Error ? err.message : String(err)}\n`)
      exitFlushed(1)
    }

process.on('uncaughtException', crashed)
process.on('unhandledRejection', crashed)
// A failed write to stderr (EPIPE: the reader went away) arrives later as an `error` event, past any
// try/catch around the write. With no listener it lands in `crashed`: the version warning alone, on a
// plugin command waiting for stdin, ended in exit 1 before the plugin ran (review finding). What
// stderr says is never the result, so losing it must not change the exit code. Not for a hook, which
// writes nothing there.
if (!hook) process.stderr.on('error', () => {})

if (statusline) {
  // Its own small chunk, not client.ts: the status line starts often and the guide text bundled
  // into client.ts is only weight here. Same rules as a hook: the backstop, then exit 0 always.
  import('./statusline')
    .then((m) => {
      setTimeout(exitQuietly, m.STATUSLINE_BUDGET_MS + 1000)
      return m.runStatusLine({
        env: process.env,
        stdin: process.stdin,
        write: (data) => void process.stdout.write(data),
        cwd: process.cwd()
      })
    })
    .then(() => exitFlushed(0), exitQuietly)
} else {
  runClient()
}

function runClient(): void {
  import('./client')
    .then((client) => {
      // The backstop is for a hook only: `ccc overlay` waits for the user for as long as it takes.
      if (hook) setTimeout(exitQuietly, client.HOOK_BUDGET_MS + 100)
      return client.run(process.argv.slice(2), process.env, process.stdin)
    })
    // The exit code of a user command (usage error 2, refused 1, else 0). Anything that goes wrong
    // outside `run` itself (a missing chunk) is a quiet 0 for a hook and exit 1 for anything else.
    // Every command exits through exitFlushed: both streams written out first.
    .then(exitFlushed, crashed)
}
