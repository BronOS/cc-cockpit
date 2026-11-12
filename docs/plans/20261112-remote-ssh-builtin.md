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

- [x] `RemoteVia` per design §2 (`ssh` with user, port, optional `auth`, ccc; `tunnel` with localPort, remotePort,
      sshHost; `direct`), validation and caps (host and user allowlists, ports 1-65535, key path absolute or `~/`,
      length caps); a record with no `auth` reads as `auto`
- [x] top-level `secrets` (`password`, `passphrase`) encrypted through `SecretStore`, stripped wherever the cookie is
      (`withoutCookie` and every `RemoteServerRecord`); `setSecret` / `getSecret`, an in-memory map for not-remembered
      secrets, `setHostKey` / `clearHostKey`; Forget clears secrets, memory and host key
- [x] `sameVia` / `add` dedupe by kind and host, user, port (SSH) or `localPort` (tunnel); a second tunnel on a used
      `localPort` refused
- [x] `RemoteServerInfo` gets `via` (no secrets exist there by construction) and `remembered: { password?, passphrase? }`
      flags; `storedSecretValues` counts the new secrets
- [x] tests: validation (each kind, bad values, old record → auto), secrets round trip, no keyring (memory used),
      Forget clears everything, `list` and records never carry a secret, dedupe and the `localPort` refusal
- [x] run tests and typecheck - must pass before next task

### Task 3: `~/.ssh/config` and `known_hosts` readers, fingerprints [model: opus]

**Files:**
- Create: `src/main/remote/ssh-config.ts`, `src/main/remote/known-hosts.ts`
- Create: `test/unit/ssh-config.test.ts`, `test/unit/known-hosts.test.ts`

- [x] `resolveSshConfig(host, {home, read})`: `Host` patterns (`*`, `?`, `!`, several per line), first value wins,
      `Include` relative to `~/.ssh` with globs and depth 4, keywords `HostName`, `User`, `Port`, `IdentityFile` (`~`
      expanded, a value with a `%` token ignored), `IdentityAgent`, `ProxyJump` / `ProxyCommand` reported as `jump`;
      `Match` blocks skipped and reported; files capped at 256 KiB
- [x] `fingerprint(keyBlob)`: `SHA256:` + unpadded base64 as `ssh-keygen -l`; `knownHostKeys(hostName, port, text)` →
      keys by type from exact plain and hashed `|1|salt|hash` entries (`[host]:port` for ports other than 22, comma
      lists), `@revoked` keys apart; wildcard, negated and `@cert-authority` lines ignored; `checkKnownHost(...)` →
      `trusted | changed | revoked | unknown`
- [x] tests for config (patterns, negation, first wins, Include loop and depth, `%` value ignored, Match, missing file)
- [x] tests for known_hosts (plain, hashed, port form, changed key, revoked, other type unknown, wildcard ignored) and
      the fingerprint against a fixed `ssh-keygen -l` output
- [x] run tests - must pass before next task

### Task 4: `SshLink`: connection, sign-in, host key, commands, owned tunnel [model: opus]

**Files:**
- Create: `src/main/remote/ssh-link.ts`, `src/main/remote/remote-status.ts` (moved parsing)
- Create: `test/unit/ssh-link.test.ts`, `test/unit/remote-status.test.ts` (moved from `ssh-tunnel.test.ts`)

- [x] move `serverStatus` / `addDeviceToken` parsing and messages (not server mode, old server, https refused, ccc
      missing, empty stdout, last line only) out of `ssh-tunnel.ts` into `remote-status.ts` over an `exec` function,
      with their tests
- [x] the `RemoteLink` interface (Solution Overview) and `SshLink`: dial from the record plus the config (record wins;
      a `jump` config refused with the design's text); `loginEnv` for `SSH_AUTH_SOCK`, `IdentityAgent` first;
      `readyTimeout` 30 s when the agent is tried, else 10 s
- [x] sign-in through `authHandler` per design §5.1: auto (agent, then config or default key files; a locked key with no
      passphrase skipped and named); password (`password` if offered, else keyboard-interactive: one echo-off prompt →
      the password, zero prompts → `[]`, a second password prompt → wrong, never resent, anything else → error); key
      (`parseKey` first, then that key only)
- [x] host verifier per design §5.3: lookup by resolved HostName and port, `serverHostKey` ordered with known types
      first; record key match / mismatch refuses without reading answers; known_hosts; else `need: hostKey`; an answer
      accepted only in the unknown branch and only equal to the key on this dial
- [x] tunnel: listener on `127.0.0.1` (saved port when free, else 0), sockets piped to `forwardOut`; a probe
      `forwardOut` before first use ("TCP forwarding is disabled on <host>"); redial with backoff 1, 2, 4 … 30 s keeping
      the listener, `web status` re-run after a redial (port change followed), sockets closed while down; auth or host
      key failure on redial stops and reports; `acquire` / `release` with 30 s grace; `dispose`
- [x] tests against an in-process `ssh2` `Server` with `home` and env injected: each auth kind (fake agent socket,
      `IdentityAgent`, password, keyboard-interactive with one prompt, with a zero-prompt round, with two password
      prompts, with an OTP prompt; key with and without passphrase; wrong secret → `again`), host key first use /
      known_hosts trusted / changed (an answer equal to the changed key still refused), forwarding disabled, exec
      parsing, server restarted on another gateway port, release grace, dispose
- [x] run tests - must pass before next task
- ➕ `remote-status.ts` exports `serverStatus(exec, host, ccc)` / `addDeviceToken(exec, host, ccc)` over
      `RemoteExec = (command) => {stdout, stderr, code}`, plus `parseServerStatus` / `parseAddDeviceToken` / `runCcc` /
      `answerLine` / `shownText` / `lastLine` and `RemoteCommandError`; a non-zero exit shows the command's last stderr
      line ("ccc on <host> failed: ..."), not ssh's. `ssh-tunnel.ts`'s spawn `serverStatus` / `addDeviceToken` are now
      thin wrappers over the parsers (its `runRemote` tests stay until Task 5 deletes the file)
- ➕ `RemoteLink` as built (`ssh-link.ts`): `state: LinkState` (`stopped | connecting | up {localPort?} | down {error,
      retryInMs?}`), `port`, `status(answers?) → LinkResult<RemoteStatus>`, `addDevice(answers?) → LinkResult<string>`,
      `acquire(answers?) → LinkResult<number>` (the local port), `release()`, `onState(cb) → unsubscribe`, `dispose()`.
      `LinkResult<T> = {ok: true, value, accepted} | {ok: false, need: LinkNeed} | {ok: false, error}`; `LinkNeed` is the
      design §5.4 object as is (`{need:'hostKey', type, sha256, address}`, `{need:'password', again?}`,
      `{need:'passphrase', path, again?}`), so Task 5 can hand it to the picker unchanged
- ➕ the link saves nothing: its store view is `get` + `getSecret` only. `accepted: {hostKey?, password?, passphrase?}`
      says what the live connection rests on that the store lacks: a host key trusted from the answer or from
      known_hosts (dropped from `accepted` once the record holds that key), and which secrets came from the answers
      (for the connection's life; saving again is harmless). Answers are used only by the call that carries them; a
      redial uses the store (remembered or memory) alone
- ➕ `localPort` is not saved by the link either: `acquire`'s value and `state.localPort` report it (Task 5 calls
      `setLocalPort` when it differs). The saved port is tried by binding it (no probe-then-bind race), else port 0
- ➕ a `@revoked` known_hosts key refuses even when the record holds that key (checked first, as `ssh` does); the
      design's step 1 read "record matches: go on"
- ➕ keyboard-interactive "a second password prompt" is decided by the prompt text: the first one-echo-off-prompt round
      gets the password; a later round with the same prompt text means wrong (never resent); any other prompt (a
      `Verification code:`) fails with its text. A key file's passphrase is asked only when the key needs one (an
      unencrypted key never reports `passphrase` as accepted)
- ➕ the gateway port is forgotten when the connection drops; sockets accepted while it is unknown are closed. A
      redial is `up` only after its `web status`; a failed `web status` after a redial drops the connection and retries
      with backoff (the server answering SSH but its cockpit still starting). Backoff restarts from 1 s after 60 s up.
      A foreground call while a redial is pending dials at once with its answers
- ➕ idle: `release` of the last user and the end of any call with no user arm the 30 s stop (connection, listener,
      sockets); a failed `acquire` counts no user. `acquire` is counted: each ok one needs exactly one `release`
- ➕ for Task 5: (1) per server one `SshLink` (`serverId`, the store, `home: os.homedir()`, `env: () => loginEnv`),
      await `loginEnvReady` before its first call; the link reads the record only through its `store` view (`get`,
      `getSecret`), so a new server not saved yet is served by a view over the draft record; (2) connect order `status(answers)` → `addDevice(answers)` in link
      mode with no cookie → `acquire(answers)` → window; merge every call's `accepted` and save it (host key via
      `setHostKey`, secrets from the request's answers via `setSecret` with the remember flag, `setLocalPort`) only when
      the window opened; (3) on a failed connect whose calls reported anything in `accepted`, `dispose` the link (and
      drop it from the map) so a connection trusted on an unsaved answer does not live on; (4) acquire once per server
      held (release at once if already held), release in `allClosed`; (5) `mintToken` = `addDevice()` with no answers,
      an `error` or a `need` both become a thrown error (background never asks); (6) `state` maps to the picker's
      `RemoteConnectionState` like `connectionOf` did (`retrying` = `retryInMs` present); subscribe with `onState` for
      `changed()`; (7) `forget` and quit call `dispose`
- ⚠️ not done (beyond the design): when the server's cockpit restarts on another gateway port with the SSH connection
      still up, page sockets fail to forward until the next drop; only a redial re-runs `web status`

### Task 5: `RemoteService` on `RemoteLink`, My own tunnel, removal of the ssh spawn [model: opus]

**Files:**
- Modify: `src/main/remote/remote-service.ts`, `src/main/remote/remote-windows.ts` (waiting page), `src/main/index.ts`,
  `src/shared/ipc.ts` (`RemoteConnectRequest` per kind, `answers`, `need` results, `remote.edit`, `remote.pickKey`),
  `src/main/ipc/router.ts`, `src/renderer/picker/connect-form.tsx` and `picker-model.ts` (minimal, to keep typecheck
  green; the real form is Task 6)
- Delete: `src/main/remote/ssh-process.ts`, `src/main/remote/ssh-tunnel.ts`, `test/unit/ssh-tunnel.test.ts`
- Modify: `test/unit/remote-service.test.ts`, grep tests that named `ssh-process.ts`

- [x] `RemoteService` on `RemoteLink`; connect and open take `answers` (all of the connect's, resent by the picker) and
      return `need` results; nothing (record, host key, secret) is saved before the dial and pairing succeed, so a
      `need` never forgets or half-saves a new server; remember → store, else memory; background redial and re-pair
      never ask
- [x] `tunnel` kind: origin `http://127.0.0.1:<localPort>`; the pasted link's token only; before every main-made load
      the probe (`http`, no cookie, no redirects, 16 KiB cap, 2 s); nothing answers → main's waiting page with the
      `ssh -N -L` command and a 3 s retry while the window is open; non-cockpit answer → error, no load; 403 from an
      old server → "update cc-cockpit on the server"
- [x] channels, all `REMOTE_CLASS` `no` and picker-only in the router: `remote.edit` (settings plus an optional link to
      sign in with; keeps cookie and host key unless host or port changed, then clears the host key),
      `remote.pickKey` (open dialog through `electron-dialog.ts`, starting in `~/.ssh`, returns a path);
      `remote.forget` also ends the link and clears memory secrets
- [x] delete the spawn code and its tests; update grep tests and comments naming them
- [x] tests: new server hostKey → password → ok saves everything once at the end; cancel after hostKey leaves nothing;
      wrong password asks once then errors; background redial does not ask; tunnel probe (nothing, non-cockpit,
      cockpit, old server); Edit keeps the cookie, clears the host key on a port change, signs in with a link; Forget
      ends the link; channels refused from a non-picker caller and from a remote view
- [x] run tests and typecheck - must pass before next task
- ➕ the store got `prepare` (validated record with a fresh id, nothing written; or the same server already saved, with
      the request's checked `via`), `insert` (saves a prepared record, re-checked), `edit` and `sameSettings`. A new
      server's connect dials with the draft (the link's store view serves `store.get(id) ?? draft`); the record, the
      host key, the secrets and `localPort` are written right before `windows.open` (which needs the record), and
      a new record is forgotten again if the window cannot open. Connects of new servers run one at a time (queue
      `connect`), so two Connects of one new host save it once. A Connect to a saved server with other settings (sign-in,
      `ccc`) is refused with "use Edit"
- ➕ every open acquires (a link down with windows open gets this call's answers), and releases at once when the
      windows already hold it; a failed connect or open disposes and drops the link unless windows hold it
- ➕ Task 4's ⚠️ is closed in `ssh-link.ts`: a page channel the server refuses (CHANNEL_OPEN_FAILURE) while SSH is up
      re-runs `web status` (one run at a time, at most once per `GATEWAY_RECHECK_MS` = 5 s) and retries that socket once
      on the new port; test "follows a gateway that moved while SSH stayed up"
- ➕ My own tunnel: `tunnel-probe.ts` (`probeTunnel` → `cockpit | nothing | other | old`, `tunnelGate`, the texts);
      connect probes first (`other` / `old` refuse before anything is saved; `nothing` still opens the window, which
      waits). `RemoteWindows` takes an optional `gate` and routes every main-made load of a tunnel server through it
      (open, sign-in, move, the reload after another window's sign-in); the waiting page is the `showError` data page,
      drawn once, retried every `TUNNEL_RETRY_MS` until it loads, errors or the window closes. A reset or a 2 s
      silence counts as `nothing` (the person's ssh accepts locally before the far end answers); 403 `unknown host`
      is `old` (also a cockpit not in server mode)
- ➕ Edit (decided): saves the settings and dials nothing for SSH (the next open asks what it needs); a tunnel or
      Direct link with a token signs in (opens the server's picker, as Connect). Another kind is refused. A changed
      connection (anything but the name) disposes the link and moves tunnel / Direct windows to the new origin.
      Host or port change → host key dropped; host, user, port or sign-in change → password / passphrase dropped
      (stored and memory). The cookie stays, except a Direct origin change drops it (the jar would send it to the new
      origin)
- ➕ "wrong password asks once then errors": main is stateless across calls, so every wrong password is
      `{need:'password', again:true}` (sent once per dial, never resent, nothing saved); counting "asked once again,
      then show the error" is the picker's (Task 6), which knows how often it asked in this connect
- ➕ the only remaining `ssh` mention in code is the jump-host text; a grep test (`no-direct-ssh2.test.ts`) keeps
      `child_process` out of `src/main/remote/`. The fake-ssh e2e test is `test.skip` ("replaced in Task 7");
      `test/fixtures/fake-ssh.mjs` stays until Task 7
- ➕ for Task 6, the IPC as built (`src/shared/ipc.ts`, `src/shared/remote-servers.ts`):
      `RemoteServerSettings` = `{kind:'ssh', host, user?, port?, auth?: SshAuth, ccc?, name?}` |
      `{kind:'tunnel', localPort, remotePort, sshHost?, link?, name?}` | `{kind:'direct', link, name?}`;
      `remote.connect` req `RemoteConnectRequest` = the ssh settings `& {answers?: RemoteAnswers}` or the other two;
      `RemoteAnswers` = `{hostKey?: string (the SHA256: fingerprint), password?, passphrase?, remember?: boolean}`
      (`remember` must be `true` to encrypt; absent = memory only);
      `remote.open` req `{serverId, projectId?, answers?}`; `remote.edit` req `RemoteEditRequest` =
      `RemoteServerSettings & {serverId}`; all three answer `RemoteConnectAnswer` = `{ok:true, serverId}` |
      `{ok:false, error}` | `{ok:false, need: RemoteNeed}`, `RemoteNeed` = `{need:'hostKey', type, sha256, address}` |
      `{need:'password', again?: true}` | `{need:'passphrase', path, again?: true}`; `remote.pickKey` req void, res
      `string | null` (absolute path). On a `need` the picker resends the same settings with every answer so far
      (to `remote.connect`, or `remote.open` for a saved server; for an SSH Edit with a typed password: `remote.edit`
      then `remote.open` with the answers). `tunnelCommand(via)` in `shared/remote-servers.ts` builds the `ssh -N -L`
      line; the add-device command is the form's own. `connectFailureText` (picker-model.ts) is the stopgap that shows
      a `need` as text; the prompts replace it

### Task 6: Picker: three-tab form, prompts, Edit [model: opus]

**Files:**
- Modify: `src/renderer/picker/connect-form.tsx`, `servers-section.tsx`, `ProjectPicker.tsx`, `picker-model.ts`,
  `styles.css`
- Create: `src/renderer/picker/remote-prompts.tsx`

- [x] form tabs SSH / My own tunnel / Link per design §3: SSH fields (host, user, port, sign in with, key path with
      Browse, passphrase, password, Remember, Advanced ccc); own tunnel fields with the two live commands (copy
      buttons) and the link field; Link tab as now
- [x] prompts: Trust this host (address, type, fingerprint, the `ssh-keygen -lf` hint, Trust and Cancel, no default
      button, Enter blocked, armed after about a second like `ApprovalDialog`); Password / Passphrase (masked,
      Remember); the picker accumulates the connect's answers and resends them all
- [x] server row: label per kind (`ssh user@host`, `tunnel :7331`, origin), Edit in the menu, "not remembered: no
      keyring" kept
- [x] test ids on the new controls; unit tests for pure helpers (command text, answer accumulation)
- [x] run tests - must pass before next task
- ➕ the form has no password, passphrase or Remember fields (decided): secrets come only through the prompts on a
      `need`, so a new, a forgotten, a not-remembered and a wrong secret take one path. The prompts carry Remember
      (on by default; off and disabled on a server row whose `cookieKept` is false, "no keyring here: kept until the
      app quits"). The tabs are a real `tablist` (←/→ move); Edit opens the same form on the server's tab with the
      other two disabled, titled "Edit <name>", button Save; a Direct server's Link field starts with its origin
- ➕ the prompt loop (`remote-prompts.tsx` `useRemotePrompts().run`, pure rules in `picker-model.ts` `promptStep` /
      `withAnswer`): answers live in the run only; each retry resends all of them. A secret's first `again: true`
      asks once more with "Wrong password. Try again." (`remote-secret-wrong`); the second ends the connect with
      "Wrong password" / "Wrong passphrase" (form: "Cannot connect: Wrong password"). A `need` for a host key just
      trusted, or for a secret answered and not called wrong, ends with an error instead of looping. Cancel (or Esc)
      ends the run silently, the form stays open. A server row's open (`remote.open`) runs the same loop; Edit sends
      `remote.edit` first and answers a `need` with `remote.open {serverId, answers}`
- ➕ Trust this host is the shared `ApprovalDialog` (Allow = Trust, Deny = Cancel; Esc cancels, Enter and Space do
      nothing, Trust armed after `APPROVAL_ARM_MS` of visibility and focus), which got two optional props:
      `focusDeny` (Cancel focused, the keyboard's way in) and `testIds`
- ➕ added beyond the IPC of Task 5: `RemoteEditRequest.forgetHostKey` (SSH Edit's "Forget the trusted host key"
      checkbox), because the changed-key refusal says "Forget the trusted key in Edit" and nothing did that; the store
      drops `hostKey` and counts it as a changed connection (the link ends); router type-checks it; tests in
      `remote-servers.test.ts`, `remote-service.test.ts`, `ipc-router.test.ts`
- ➕ `viaLabel` shows an SSH port when one is set (`ssh me@box:2222`, an IPv6 literal bracketed); `connectFailureText`
      is gone. Copy buttons use a selected textarea and `execCommand('copy')`: the app page has no clipboard
      permission (`permissions.ts`); checked in a throwaway e2e that read Electron's clipboard back
- ➕ test ids for Task 7 (all `data-testid`): tabs `connect-tab-ssh|tunnel|link`; SSH `connect-ssh-host`,
      `connect-ssh-user`, `connect-ssh-port`, `connect-ssh-auth-auto|password|key` (radios), `connect-ssh-key-path`,
      `connect-ssh-key-browse`, `connect-ssh-ccc` (under Advanced, a closed `<details>`), `connect-forget-host-key`
      (Edit only); tunnel `connect-tunnel-ssh-host`, `connect-tunnel-remote-port`, `connect-tunnel-local-port`,
      `connect-tunnel-command` and `connect-tunnel-command-copy`, `connect-add-device-command` and
      `connect-add-device-command-copy`, `connect-tunnel-link`; Link `connect-link`; all tabs `connect-name`,
      `connect-submit`, `connect-cancel`, `connect-error`; the ⋯ menu's `server-menu-edit`; Trust
      `remote-hostkey-prompt`, `remote-hostkey-address`, `remote-hostkey-type`, `remote-hostkey-fingerprint`,
      `remote-hostkey-trust` (disabled for about a second), `remote-hostkey-cancel`; secret `remote-secret-prompt`,
      `remote-secret-input`, `remote-secret-remember`, `remote-secret-ok`, `remote-secret-cancel`,
      `remote-secret-wrong`. Labels too: the SSH tab's field is "Host", the tunnel's link "Add-device link", the Link
      tab's "Link"; the Direct e2e now picks the tab with `getByRole('tab', { name: 'Link' })` (the skipped SSH test's
      helper was moved to the new labels as well)

### Task 7: e2e: built-in SSH and My own tunnel [model: sonnet]

**Files:**
- Create: `test/fixtures/ssh-server.mjs`
- Delete: `test/fixtures/fake-ssh.mjs`
- Modify: `test/e2e/remote-desktop.spec.ts`

- [x] `ssh-server.mjs`: an `ssh2` `Server` on a loopback port given or random (prints it), the host key from a file
      made once per test (so a restart keeps it, and a second file gives the "changed" case), password and public-key
      auth from args, `exec` runs the command locally with `sh -c`, `direct-tcpip` connects locally; the desktop app's
      `HOME` is a temp dir with an empty `.ssh/known_hosts` and `.config/cc-cockpit/bin/ccc` symlinked to the
      server's wrapper (as `fake-ssh.mjs` did; `REMOTE_SCRIPT` sets `CCC` itself), `SSH_AUTH_SOCK` blank
- [x] built-in SSH: Trust dialog shows the fixture's fingerprint, password prompt with Remember off, the project opens
      on a loopback origin, the device is named "cc-cockpit desktop on …"; a revoke re-pairs once; the fixture
      restarted on the same port reconnects with no prompt; a relaunch asks the password again (not remembered), and
      with Remember on does not; a changed host key refuses
- [x] My own tunnel: the waiting page shows the command while nothing listens; starting a Node relay to the gateway
      loads the project with the pasted add-device link
- [x] Direct test unchanged and passing
- [x] run `npm run test:e2e -- remote-desktop` - must pass before next task
- ➕ built as: `ssh-server.mjs` takes `--host-key --user --password --pubkey --home --ccc --port --log` (the fixture makes the
      `ccc` symlink in its own remote HOME itself and logs `exec <command>` / `tcpip <port>`); the spec has three new tests
      (SSH happy path with revoke, sshd restart, relaunch with and without Remember; wrong password then a changed host key;
      My own tunnel with a Node relay). The desktop's HOME is launchCockpit's temp home (`os.homedir()` follows HOME), its
      SHELL is the fake shell, and `SSH_AUTH_SOCK` is removed from its env, so the real agent and `~/.ssh` are never read
- ➕ `ccc web revoke` needs `--` before a device id: ids are base64url and one in 64 starts with `-` (the Direct-era test
      was flaky on it)
- ⚠️ not covered in e2e: public-key auth (the fixture accepts `--pubkey`, no test uses it; unit tests cover it)

### Task 8: Docs [model: sonnet]

**Files:**
- Modify: `docs/features.md` ("Remote servers"), `docs/design-web.md` (§9 bullets), `README.md`, `CLAUDE.md`
  (Implementation patterns bullet for remote servers)

- [x] features.md: the three ways in, sign-in options and Remember, the host-key dialog, the config fields read and
      what is not supported (ProxyJump, FIDO, certificates, 2FA → My own tunnel), the own-tunnel cookie caveat
- [x] CLAUDE.md bullet: `ssh2` only in `ssh-client.ts`, no `ssh` spawn, the app owns the listener, host key never a
      click-through when changed, secrets never leave main
- [x] README bullet adjusted

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
