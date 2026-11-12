# Remote servers: built-in SSH client and My own tunnel

## Overview
- The first version of remote servers (`docs/plans/completed/20261112-remote-desktop.md`) reached a server over SSH by
  running the person's `ssh` in BatchMode: the person had to set up keys, the agent and the host key in a terminal
  before the app could connect. Too hard to use.
- This plan replaces that with two choices (design: `docs/design-remote-desktop.md`, revision 2):
  - **SSH, built in**: the `ssh2` library. Password, key file with optional passphrase, or agent and default keys;
    secrets remembered encrypted or asked each launch; the host key confirmed in the picker with its fingerprint (or
    vouched for by `~/.ssh/known_hosts`); basic `~/.ssh/config` fields; the app owns the local listener, so the tunnel's
    port race is gone; automatic pairing and re-pairing as before.
  - **My own tunnel**: the person runs the `ssh -N -L` command the app shows and pastes the `ccc web add-device` link;
    the app connects to `127.0.0.1:<local port>`, probing it first and waiting with the command on screen when nothing
    answers.
- Direct (an access link) is unchanged. Spawning the system `ssh` is removed (`ssh-process.ts`, `ssh-tunnel.ts`,
  `test/fixtures/fake-ssh.mjs`).

## Context (from discovery)
- Current remote code: `src/main/remote/` (`remote-service.ts` with the `RemoteTunnel` / `RemoteSsh` seams,
  `remote-servers.ts` store, `remote-windows.ts`, `electron-remote-window.ts`, `remote-cookie.ts`, `ssh-process.ts`,
  `ssh-tunnel.ts`), `src/shared/remote-servers.ts` (`RemoteVia`, validation, `parseRemoteLink`, `checkSshHost`,
  `checkCccOverride`, `REMOTE_SCRIPT`, `remoteCommand`), IPC `remote.*` in `src/shared/ipc.ts` (`RemoteServerInfo`,
  `RemoteConnectRequest`, `RemoteConnectAnswer`), router `registerRemoteServerHandlers` in `src/main/ipc/router.ts`,
  wiring in `src/main/index.ts`.
- Picker: `src/renderer/picker/servers-section.tsx`, `connect-form.tsx`, `ProjectPicker.tsx`, `parts.tsx`.
- Approval dialog precedent (no default button, armed after visibility): `ApprovalDialog` in the renderer.
- Dialogs only through `main/dialogs/electron-dialog.ts` (`no-direct-dialog.test.ts`).
- Build: electron-vite externalises `dependencies` (main's bundle `require`s `ajv`, `node-pty`) and bundles
  `devDependencies`; `electron-builder.yml` ships `dependencies` and rebuilds native ones (`postinstall` / npmRebuild);
  `test/unit/packaging-config.test.ts` checks what ships.
- Tests: `test/unit/ssh-tunnel.test.ts`, `remote-service.test.ts`, `test/e2e/remote-desktop.spec.ts` (Direct and
  fake-ssh SSH), `test/fixtures/fake-ssh.mjs`, `test/e2e/server-fixtures.ts` (`launchServer`).
- `ssh2` 1.17.0 (2025-08-20), MIT, deps `asn1`, `bcrypt-pbkdf`; optional native `sshcrypto` binding and
  `cpu-features`, with a pure-JS fallback.

## Development Approach
- **testing approach**: Regular (code first, then tests).
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- `ssh2` imported only in `src/main/remote/ssh-client.ts` (grep test); logic in plain modules tested against
  `ssh2`'s own `Server` in-process. No regexes in the config, known_hosts or link parsers.
- Tests never touch the real `~/.ssh` or agent: `home` and the env are injected everywhere, `SSH_AUTH_SOCK` blank
  unless a test sets a fake agent.
- Every task leaves `npm run typecheck` green: a shape change carries the minimal change to its users in the same task.
- Revised after a Fable review (2026-11-12): answers accumulated and nothing saved before success, secrets beside the
  cookie, `auth` optional (old records read as auto), ssh2 bundled as a devDependency with its native parts external,
  an in-Electron handshake check (no chacha20 there), a per-server link interface, keyboard-interactive and agent
  details, host-key lookup by HostName with preferred key types, cuts (live config hints, suggested port, known_hosts
  wildcards, `%` tokens).
- Secrets (password, passphrase, device cookie) never in a log, an event, a `remote.list` answer or a URL.
- New or changed IPC channels keep `REMOTE_CLASS` `no`.
- Dense "why" comments (repo convention).

## Testing Strategy
- **unit tests** (vitest): readers and store with temp dirs; `SshLink` against an in-process `ssh2` `Server` on a
  random loopback port with generated host and client keys; the own-tunnel probe against local HTTP servers.
- **e2e** (Playwright, `npm run test:e2e`): `launchServer` plus the desktop app; built-in SSH through an `ssh2` server
  fixture process; My own tunnel through a Node relay; Direct as now.
- `node scripts/server-mode-smoke.mjs` is not needed (no server-mode start code changes).

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with actual work done

## Solution Overview
- **`ssh-client.ts`** (adapter): the only `ssh2` import; a narrow interface (`dial(options) → SshConnection` with
  `exec`, `forwardOut`, `end`, `on('close')`), algorithms restricted (design §8).
- **`ssh-config.ts`, `known-hosts.ts`**: plain readers; **`remote-status.ts`**: the `web status` / `add-device`
  parsing moved out of `ssh-tunnel.ts` with its tests; **`ssh-link.ts`**: one connection per server (auth order, host
  verifier, exec with cap and deadline, owned loopback listener with `forwardOut`, redial with backoff, release grace)
  behind a new per-server `RemoteLink` interface (`status`, `addDevice`, `acquire`, `release`, `port`, `onState`, each
  taking the connect's `answers` and able to return a `need`); the old host-keyed `RemoteSsh` / `RemoteTunnel` seams go.
- **`RemoteService`**: new `via` kinds; typed `need` results (`hostKey`, `password`, `passphrase`) and `answers` on the
  next call; secrets remembered encrypted or held in memory; own-tunnel probe and waiting page.
- **Picker**: three-tab form (SSH, My own tunnel, Link), Edit, prompt dialogs (Trust this host, Password,
  Passphrase), key file Browse; the picker accumulates a connect's answers and resends them all.

## Technical Details
- Record shape (`via`, `SshAuth`, `secrets`, `hostKey`): design §2. A record with no `auth` reads as `auto`.
- Sign-in order and keyboard-interactive rule: design §5.1. Host key decisions and known_hosts formats: design §5.3.
- `need` / `answers` protocol: design §5.4. Config keywords and limits: design §5.5.
- Own tunnel: probe `GET /auth/session` with no cookie, 2 s timeout, retry every 3 s while a window waits; a
  non-cockpit answer refuses (design §6).
- Algorithms: `ssh2` defaults minus `ssh-rsa` host keys; server host key types ordered with the known ones first.
- Nothing from a connect's answers (host key, secret, new record) is saved until the dial and pairing succeed.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: a real SSH host (agent, password, key with passphrase), macOS, a dropped network.

## Implementation Steps

### Task 1: `ssh2` dependency and the adapter [model: opus]

**Files:**
- Modify: `package.json`, `package-lock.json`, `electron.vite.config.ts`, `test/unit/packaging-config.test.ts`
- Create: `src/main/remote/ssh-client.ts`
- Create: `test/unit/ssh-client.test.ts`, `test/unit/no-direct-ssh2.test.ts`
- ➕ Create: `scripts/ssh2-electron-check.mjs`

- [x] add `ssh2` pinned exact (`1.17.0`) as a **devDependency** (bundled into main, so neither its install-time
      `sshcrypto.node` nor `cpu-features` ships or gets rebuilt) and `@types/ssh2`; rollup `external` for
      `cpu-features` and `*.node` so the optional requires stay unresolved and `ssh2` takes its pure-JS path; a comment
      in `electron.vite.config.ts` says why
- [x] `packaging-config.test.ts`: `ssh2` is not in `dependencies`, and neither `cpu-features` nor a `.node` file of
      `ssh2` can ship
- [x] `ssh-client.ts`: `dial(opts): Promise<SshConnection>` over `ssh2.Client` (host, port, username, `authHandler`,
      `hostVerifier`, `agent`, `readyTimeout`, keepalive 15 s × 3, `algorithms` with `ssh-rsa` host keys removed and
      `serverHostKey` order from the caller, no `debug`), and the connection's `exec(command, {maxBytes, timeoutMs})`,
      `forwardOut(srcPort, dstPort) → Duplex`, `end()`, `onClose(cb)`; errors keep `ssh2`'s `level`; `parseKey(data,
      passphrase?)` exposed (encrypted / wrong passphrase / unsupported told apart)
- [x] grep test: `ssh2` imported only in `ssh-client.ts` under `src/`
- [x] unit test against `ssh2`'s `Server` (in-process, generated ed25519 host key): password dial, exec output and exit
      code, output cap, deadline, `forwardOut` to a local echo server, `ssh-rsa`-only host key refused, `parseKey` cases
- [x] in-Electron check (Electron has no chacha20): a script run as Electron's main (as `web-terminal-bench.mjs` does)
      does a handshake, an exec and a `forwardOut` against an in-process `ssh2` server from the built bundle; then the
      same from `npm run package:dir`'s app - must work before Task 2
- ➕ the native parts are resolved to a stub module that throws (plugin `cc-ssh2-pure-js` in
      `electron.vite.config.ts`, only for requires from inside `node_modules/ssh2/`) instead of rollup `external`: an
      external `cpu-features` would still be found in a dev checkout's node_modules and not in the package; the stub
      makes the pure-JS path the same in both, and no require of a path outside the bundle is left
- ➕ the adapter is its own entry of the main build (`out/main/ssh-client.js`), so the check loads exactly the bytes
      that ship (from `out/` and from a packaged `app.asar`); main imports it like any module in later tasks
- ➕ `scripts/ssh2-electron-check.mjs [executable]`: no argument runs `out/` as this repo's Electron's main (headless
      on Linux); with a packaged executable it runs that executable as Node (`ELECTRON_RUN_AS_NODE`, as `ccc` does: a
      packaged app takes no script as main; same BoringSSL). Both passed (Electron 45.1.0, no chacha20 in `crypto`):
      kex `curve25519-sha256@libssh.org`, host key `ssh-ed25519`, cipher `aes128-gcm@openssh.com`, exec and
      `forwardOut` fine. The packaged run used a scratch output dir (`--config.directories.output`), and its
      `app.asar` has no `ssh2`, `cpu-features` or `sshcrypto` file. Run it after changing `ssh-client.ts` or the
      bundling (Task 10: list it in CLAUDE.md "Commands")
- ➕ interface notes for Task 4: the agent socket goes in the `{ type: 'agent', agent }` auth method, not a dial option;
      `authHandler` gets `null` first (return `none` to learn the server's methods); a keyboard-interactive round with
      no prompts is answered by `ssh2` itself (`[]`) and never reaches `onRound`, which returns answers or
      `{ fail: text }`; `preferredHostKeyTypes` takes known_hosts types (`ssh-rsa` stands for `rsa-sha2-512/256`); a
      verifier refusal rejects with `level: 'handshake'` and `hostKeyRefused: true`; an unreachable agent does not end
      the dial (`ssh2` moves on) and its text rides on the final error as `agentError`
- ➕ `npm ci` runs `ssh2`'s install script (a node-gyp build of `sshcrypto.node` for plain Node, exit 0 even when it
      fails) and builds the optional `cpu-features`: harmless, neither is bundled nor shipped, and electron-builder's
      rebuild collects production dependencies only (`npm ls --omit dev` lists none of them)

### Task 2: Saved servers: new `via` kinds, secrets, host key [model: opus]

**Files:**
- Modify: `src/shared/remote-servers.ts`, `src/main/remote/remote-servers.ts`, `src/shared/ipc.ts` (types only),
  `src/main/secrets/` (`storedSecretValues`), and the minimal follow-up in `remote-service.ts` / picker model to keep
  typecheck green
- Modify: `test/unit/remote-servers*.test.ts`

- [ ] `RemoteVia` per design §2 (`ssh` with user, port, optional `auth`, ccc; `tunnel` with localPort, remotePort,
      sshHost; `direct`), validation and caps (host and user allowlists, ports 1-65535, key path absolute or `~/`,
      length caps); a record with no `auth` reads as `auto`
- [ ] top-level `secrets` (`password`, `passphrase`) encrypted through `SecretStore`, stripped wherever the cookie is
      (`withoutCookie` and every `RemoteServerRecord`); `setSecret` / `getSecret`, an in-memory map for not-remembered
      secrets, `setHostKey` / `clearHostKey`; Forget clears secrets, memory and host key
- [ ] `sameVia` / `add` dedupe by kind and host, user, port (SSH) or `localPort` (tunnel); a second tunnel on a used
      `localPort` refused
- [ ] `RemoteServerInfo` gets `via` (no secrets exist there by construction) and `remembered: { password?, passphrase? }`
      flags; `storedSecretValues` counts the new secrets
- [ ] tests: validation (each kind, bad values, old record → auto), secrets round trip, no keyring (memory used),
      Forget clears everything, `list` and records never carry a secret, dedupe and the `localPort` refusal
- [ ] run tests and typecheck - must pass before next task

### Task 3: `~/.ssh/config` and `known_hosts` readers, fingerprints [model: opus]

**Files:**
- Create: `src/main/remote/ssh-config.ts`, `src/main/remote/known-hosts.ts`
- Create: `test/unit/ssh-config.test.ts`, `test/unit/known-hosts.test.ts`

- [ ] `resolveSshConfig(host, {home, read})`: `Host` patterns (`*`, `?`, `!`, several per line), first value wins,
      `Include` relative to `~/.ssh` with globs and depth 4, keywords `HostName`, `User`, `Port`, `IdentityFile` (`~`
      expanded, a value with a `%` token ignored), `IdentityAgent`, `ProxyJump` / `ProxyCommand` reported as `jump`;
      `Match` blocks skipped and reported; files capped at 256 KiB
- [ ] `fingerprint(keyBlob)`: `SHA256:` + unpadded base64 as `ssh-keygen -l`; `knownHostKeys(hostName, port, text)` →
      keys by type from exact plain and hashed `|1|salt|hash` entries (`[host]:port` for ports other than 22, comma
      lists), `@revoked` keys apart; wildcard, negated and `@cert-authority` lines ignored; `checkKnownHost(...)` →
      `trusted | changed | revoked | unknown`
- [ ] tests for config (patterns, negation, first wins, Include loop and depth, `%` value ignored, Match, missing file)
- [ ] tests for known_hosts (plain, hashed, port form, changed key, revoked, other type unknown, wildcard ignored) and
      the fingerprint against a fixed `ssh-keygen -l` output
- [ ] run tests - must pass before next task

### Task 4: `SshLink`: connection, sign-in, host key, commands, owned tunnel [model: opus]

**Files:**
- Create: `src/main/remote/ssh-link.ts`, `src/main/remote/remote-status.ts` (moved parsing)
- Create: `test/unit/ssh-link.test.ts`, `test/unit/remote-status.test.ts` (moved from `ssh-tunnel.test.ts`)

- [ ] move `serverStatus` / `addDeviceToken` parsing and messages (not server mode, old server, https refused, ccc
      missing, empty stdout, last line only) out of `ssh-tunnel.ts` into `remote-status.ts` over an `exec` function,
      with their tests
- [ ] the `RemoteLink` interface (Solution Overview) and `SshLink`: dial from the record plus the config (record wins;
      a `jump` config refused with the design's text); `loginEnv` for `SSH_AUTH_SOCK`, `IdentityAgent` first;
      `readyTimeout` 30 s when the agent is tried, else 10 s
- [ ] sign-in through `authHandler` per design §5.1: auto (agent, then config or default key files; a locked key with no
      passphrase skipped and named); password (`password` if offered, else keyboard-interactive: one echo-off prompt →
      the password, zero prompts → `[]`, a second password prompt → wrong, never resent, anything else → error); key
      (`parseKey` first, then that key only)
- [ ] host verifier per design §5.3: lookup by resolved HostName and port, `serverHostKey` ordered with known types
      first; record key match / mismatch refuses without reading answers; known_hosts; else `need: hostKey`; an answer
      accepted only in the unknown branch and only equal to the key on this dial
- [ ] tunnel: listener on `127.0.0.1` (saved port when free, else 0), sockets piped to `forwardOut`; a probe
      `forwardOut` before first use ("TCP forwarding is disabled on <host>"); redial with backoff 1, 2, 4 … 30 s keeping
      the listener, `web status` re-run after a redial (port change followed), sockets closed while down; auth or host
      key failure on redial stops and reports; `acquire` / `release` with 30 s grace; `dispose`
- [ ] tests against an in-process `ssh2` `Server` with `home` and env injected: each auth kind (fake agent socket,
      `IdentityAgent`, password, keyboard-interactive with one prompt, with a zero-prompt round, with two password
      prompts, with an OTP prompt; key with and without passphrase; wrong secret → `again`), host key first use /
      known_hosts trusted / changed (an answer equal to the changed key still refused), forwarding disabled, exec
      parsing, server restarted on another gateway port, release grace, dispose
- [ ] run tests - must pass before next task

### Task 5: `RemoteService` on `RemoteLink`, My own tunnel, removal of the ssh spawn [model: opus]

**Files:**
- Modify: `src/main/remote/remote-service.ts`, `src/main/remote/remote-windows.ts` (waiting page), `src/main/index.ts`,
  `src/shared/ipc.ts` (`RemoteConnectRequest` per kind, `answers`, `need` results, `remote.edit`, `remote.pickKey`),
  `src/main/ipc/router.ts`, `src/renderer/picker/connect-form.tsx` and `picker-model.ts` (minimal, to keep typecheck
  green; the real form is Task 6)
- Delete: `src/main/remote/ssh-process.ts`, `src/main/remote/ssh-tunnel.ts`, `test/unit/ssh-tunnel.test.ts`
- Modify: `test/unit/remote-service.test.ts`, grep tests that named `ssh-process.ts`

- [ ] `RemoteService` on `RemoteLink`; connect and open take `answers` (all of the connect's, resent by the picker) and
      return `need` results; nothing (record, host key, secret) is saved before the dial and pairing succeed, so a
      `need` never forgets or half-saves a new server; remember → store, else memory; background redial and re-pair
      never ask
- [ ] `tunnel` kind: origin `http://127.0.0.1:<localPort>`; the pasted link's token only; before every main-made load
      the probe (`http`, no cookie, no redirects, 16 KiB cap, 2 s); nothing answers → main's waiting page with the
      `ssh -N -L` command and a 3 s retry while the window is open; non-cockpit answer → error, no load; 403 from an
      old server → "update cc-cockpit on the server"
- [ ] channels, all `REMOTE_CLASS` `no` and picker-only in the router: `remote.edit` (settings plus an optional link to
      sign in with; keeps cookie and host key unless host or port changed, then clears the host key),
      `remote.pickKey` (open dialog through `electron-dialog.ts`, starting in `~/.ssh`, returns a path);
      `remote.forget` also ends the link and clears memory secrets
- [ ] delete the spawn code and its tests; update grep tests and comments naming them
- [ ] tests: new server hostKey → password → ok saves everything once at the end; cancel after hostKey leaves nothing;
      wrong password asks once then errors; background redial does not ask; tunnel probe (nothing, non-cockpit,
      cockpit, old server); Edit keeps the cookie, clears the host key on a port change, signs in with a link; Forget
      ends the link; channels refused from a non-picker caller and from a remote view
- [ ] run tests and typecheck - must pass before next task

### Task 6: Picker: three-tab form, prompts, Edit [model: opus]

**Files:**
- Modify: `src/renderer/picker/connect-form.tsx`, `servers-section.tsx`, `ProjectPicker.tsx`, `picker-model.ts`,
  `styles.css`
- Create: `src/renderer/picker/remote-prompts.tsx`

- [ ] form tabs SSH / My own tunnel / Link per design §3: SSH fields (host, user, port, sign in with, key path with
      Browse, passphrase, password, Remember, Advanced ccc); own tunnel fields with the two live commands (copy
      buttons) and the link field; Link tab as now
- [ ] prompts: Trust this host (address, type, fingerprint, the `ssh-keygen -lf` hint, Trust and Cancel, no default
      button, Enter blocked, armed after about a second like `ApprovalDialog`); Password / Passphrase (masked,
      Remember); the picker accumulates the connect's answers and resends them all
- [ ] server row: label per kind (`ssh user@host`, `tunnel :7331`, origin), Edit in the menu, "not remembered: no
      keyring" kept
- [ ] test ids on the new controls; unit tests for pure helpers (command text, answer accumulation)
- [ ] run tests - must pass before next task

### Task 7: e2e: built-in SSH and My own tunnel [model: sonnet]

**Files:**
- Create: `test/fixtures/ssh-server.mjs`
- Delete: `test/fixtures/fake-ssh.mjs`
- Modify: `test/e2e/remote-desktop.spec.ts`

- [ ] `ssh-server.mjs`: an `ssh2` `Server` on a loopback port given or random (prints it), the host key from a file
      made once per test (so a restart keeps it, and a second file gives the "changed" case), password and public-key
      auth from args, `exec` runs the command locally with `sh -c`, `direct-tcpip` connects locally; the desktop app's
      `HOME` is a temp dir with an empty `.ssh/known_hosts` and `.config/cc-cockpit/bin/ccc` symlinked to the
      server's wrapper (as `fake-ssh.mjs` did; `REMOTE_SCRIPT` sets `CCC` itself), `SSH_AUTH_SOCK` blank
- [ ] built-in SSH: Trust dialog shows the fixture's fingerprint, password prompt with Remember off, the project opens
      on a loopback origin, the device is named "cc-cockpit desktop on …"; a revoke re-pairs once; the fixture
      restarted on the same port reconnects with no prompt; a relaunch asks the password again (not remembered), and
      with Remember on does not; a changed host key refuses
- [ ] My own tunnel: the waiting page shows the command while nothing listens; starting a Node relay to the gateway
      loads the project with the pasted add-device link
- [ ] Direct test unchanged and passing
- [ ] run `npm run test:e2e -- remote-desktop` - must pass before next task

### Task 8: Docs [model: sonnet]

**Files:**
- Modify: `docs/features.md` ("Remote servers"), `docs/design-web.md` (§9 bullets), `README.md`, `CLAUDE.md`
  (Implementation patterns bullet for remote servers)

- [ ] features.md: the three ways in, sign-in options and Remember, the host-key dialog, the config fields read and
      what is not supported (ProxyJump, FIDO, certificates, 2FA → My own tunnel), the own-tunnel cookie caveat
- [ ] CLAUDE.md bullet: `ssh2` only in `ssh-client.ts`, no `ssh` spawn, the app owns the listener, host key never a
      click-through when changed, secrets never leave main
- [ ] README bullet adjusted

### Task 9: Verify acceptance criteria [model: sonnet]
- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases (wrong password, locked key with no passphrase, changed host key, no keyring, own tunnel down,
      old server, https server)
- [ ] run full test suite: `npm run typecheck && npm run lint && npm test && npm run test:plugins`
- [ ] run e2e tests: `npm run test:e2e`
- [ ] `npm run package:dir` and connect from the packaged app to this machine's server over built-in SSH

### Task 10: [Final] Update documentation [model: sonnet]
- [ ] update README.md if needed
- [ ] update CLAUDE.md State line
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**:
- a real SSH host: agent key, password-only server, key with passphrase, an alias from `~/.ssh/config`
- macOS desktop (agent from the Dock, keychain)
- drop the network for a minute; the link redials and the page reconnects
