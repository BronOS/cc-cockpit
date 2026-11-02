// Plan B, Task 5: plugin CLI routing. A linked plugin declares `contributes.cli`; from inside a
// Claude tab, `ccc demo …` goes through main to the plugin's handler in the window's host, and its
// stdout, stderr and exit code come back. The fake `claude` runs `/ccc <args>` like Claude's Bash
// tool and prints `FAKE-CLAUDE ccc exit=<code> out=<json> err=<json>`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-cli')
const ID = 'test.hostcli'

test('a plugin command round-trips from inside a Claude tab, exit code kept', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  // Linked but not enabled in this project: main says so, exit 1.
  await cockpit.typeLine('/ccc demo echo a b')
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=1 out="" err="ccc: demo comes from plugin test\.hostcli, which is not enabled/)

  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })

  await cockpit.typeLine('/ccc demo echo a b')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="a b\\n" err=""')

  // The plugin's own exit code and stderr.
  await cockpit.typeLine('/ccc demo fail')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=3 out="" err="demo failed on purpose\\n"')

  // A handler that throws: exit 1, the message on stderr.
  await cockpit.typeLine('/ccc demo throw')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=1 out="" err="ccc demo: fixture boom\\n"')

  // --help is the declared usage, without running the handler.
  await cockpit.typeLine('/ccc demo --help')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="usage: ccc demo echo <words...> | demo fail | demo cwd\\nEcho the arguments back\\n"')

  // A name no plugin declares.
  await cockpit.typeLine('/ccc nosuch')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=1 out="" err="ccc: unknown command: nosuch\\n"')

  // ccc help lists the project's plugin commands.
  await cockpit.typeLine('/ccc help')
  await cockpit.waitForTerminalText('plugin commands of this project:')
})

// A shell tab and a terminal overlay carry a WINDOW token (design §2): plugin commands and the
// other window-level commands reach their window without --project, while everything that needs a
// Claude session refuses it. The fake shell is plain `sh -i`, so lines are typed as they are
// (no leading `/`, that is the fake claude's).
test('a shell tab and a terminal overlay run plugin commands without --project; session commands refuse their token', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })

  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  // `cd /` first: the token, not the cwd, says which window this is. Each check waits for text
  // only the command's output can produce (the typed line is on the screen too).
  await cockpit.typeLine('cd / && out=$(ccc demo echo abc); echo "demo=$? out=[$out]"')
  await cockpit.waitForTerminalText('demo=0 out=[abc]')

  // `ccc help` lists the window's plugin commands here too.
  await cockpit.typeLine('echo "help=$(ccc help | grep -c \'plugin commands of this project\')"')
  await cockpit.waitForTerminalText('help=1')

  // Session-only: refused by main with its reason (exit 1), not taken for a missing token.
  await cockpit.typeLine('ccc session note hi; echo "note=$?"')
  await cockpit.waitForTerminalText('session.note needs a Claude session')
  await cockpit.waitForTerminalText('note=1')

  // A hook never fails (exit 0) and main records nothing: no session for any tab of this window.
  await cockpit.typeLine('echo \'{"session_id":"x"}\' | ccc hook Stop; echo "hook=$?"')
  await cockpit.waitForTerminalText('hook=0')
  await cockpit.typeLine('echo "sessions=$(ccc sessions --json)"')
  await cockpit.waitForTerminalText('sessions=[]')
  expect(await cockpit.hook<unknown[]>('sessions', cockpit.projectDir)).toEqual([])

  // A terminal overlay of the window: its program runs a plugin command by the overlay's own token.
  const out = join(cockpit.projectDir, 'overlay-out.txt')
  const handle = await cockpit.hook<number | undefined>('openOverlay', cockpit.projectDir, {
    kind: 'terminal',
    argv: ['/bin/sh', '-c', `cd / && ccc demo echo from overlay > '${out}' 2>&1; echo "rc=$?" >> '${out}'`],
    cwd: cockpit.projectDir
  })
  expect(handle).toBeDefined()
  await expect
    .poll(async () => (await cockpit.hook<{ result?: unknown } | undefined>('overlayResult', handle))?.result, { timeout: 15_000 })
    .toEqual({ kind: 'exit', code: 0 })
  expect(readFileSync(out, 'utf8')).toBe('from overlay\nrc=0\n')
})
