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
- Build: `electron.vite.config.ts` bundles main's dependencies (only `node-pty` is external); `electron-builder.yml`
  lists unpacked `node_modules`.
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
- **`ssh-config.ts`, `known-hosts.ts`**: plain readers; **`ssh-link.ts`**: one connection per server (auth order,
  host verifier, exec with cap and deadline, owned loopback listener with `forwardOut`, redial with backoff, release
  grace), implementing the `RemoteTunnel` / `RemoteSsh` seams `RemoteService` already has.
- **`RemoteService`**: new `via` kinds; typed `need` results (`hostKey`, `password`, `passphrase`) and `answers` on the
  next call; secrets remembered encrypted or held in memory; own-tunnel probe and waiting page.
- **Picker**: three-tab form (SSH, My own tunnel, Link), Edit, prompt dialogs (Trust this host, Password,
  Passphrase), key file Browse.

## Technical Details
- Record shape (`via`, `SshAuth`, `hostKey`): design §2. Validation drops records of the old `ssh` shape (never released).
- Sign-in order and keyboard-interactive rule: design §5.1. Host key decisions and known_hosts formats: design §5.3.
- `need` / `answers` protocol: design §5.4. Config keywords and limits: design §5.5.
- Own tunnel: probe `GET /auth/session` with no cookie, 2 s timeout, retry every 3 s while a window waits; a
  non-cockpit answer refuses (design §6).
- Algorithms: `ssh2` defaults minus `ssh-rsa` host keys, CBC ciphers, `diffie-hellman-group1-sha1`,
  `diffie-hellman-group14-sha1`.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: a real SSH host (agent, password, key with passphrase), macOS, a dropped network.

## Implementation Steps

### Task 1: `ssh2` dependency and the adapter [model: opus]

**Files:**
- Modify: `package.json`, `package-lock.json`, `electron.vite.config.ts`, `electron-builder.yml` (only if needed)
- Create: `src/main/remote/ssh-client.ts`
- Create: `test/unit/ssh-client.test.ts`, `test/unit/no-direct-ssh2.test.ts`

- [ ] add `ssh2` pinned exact (`1.17.0`) and `@types/ssh2` (dev); decide bundling: bundle the pure-JS library into
      main (the optional native binding unresolved and ignored) or mark it external and ship it; whichever, the
      packaged app must load it with no native module and no install-time build (write the choice and why in a comment
      in `electron.vite.config.ts`)
- [ ] `ssh-client.ts`: `dial(opts): Promise<SshConnection>` over `ssh2.Client` (host, port, username, `authHandler`,
      `hostVerifier`, `readyTimeout` 10 s, keepalive 15 s × 3, restricted `algorithms`, no `debug`), and the
      connection's `exec(command, {maxBytes, timeoutMs})`, `forwardOut(srcPort, dstPort) → Duplex`, `end()`,
      `onClose(cb)`; errors keep `ssh2`'s `level`
- [ ] grep test: `ssh2` imported only in `ssh-client.ts` under `src/`
- [ ] unit test against `ssh2`'s `Server` (in-process, generated ed25519 host key): dial with a password, exec output and
      exit code, output cap, deadline, `forwardOut` to a local echo server, a refused `ssh-rsa`-only host key
- [ ] `npm run build` and `npm run package:dir`, then load the library from the packaged app (a one-line main-process
      check under `CC_COCKPIT_TEST` or a script) - must work before Task 2

### Task 2: Saved servers: new `via` kinds, secrets, host key [model: sonnet]

**Files:**
- Modify: `src/shared/remote-servers.ts`, `src/main/remote/remote-servers.ts`, `src/shared/ipc.ts` (types only),
  `src/main/secrets/` (`storedSecretValues`)
- Modify: `test/unit/remote-servers*.test.ts`

- [ ] `RemoteVia` per design §2 (`ssh` with user, port, `auth: SshAuth`, ccc; `tunnel` with localPort, remotePort,
      sshHost; `direct`), `hostKey`, validation and caps (user and host allowlists, ports 1-65535, key path absolute
      or `~/`, length caps); the old `ssh` shape fails validation and is dropped
- [ ] store: `setSecret(id, 'password' | 'passphrase', plain | undefined)` encrypted through `SecretStore`, `getSecret`,
      an in-memory map for not-remembered secrets (`holdSecret`, cleared on Forget), `setHostKey`, `clearHostKey`;
      Forget clears secrets, memory and host key
- [ ] `RemoteServerInfo` gains `via` details for the picker and `remembered: { password?, passphrase? }` flags, never
      the values; `storedSecretValues` counts the new secrets
- [ ] tests: validation (each kind, bad values, old shape dropped), secrets round trip, no keyring (not remembered,
      memory used), Forget clears everything, `list` never returns a secret
- [ ] run tests - must pass before next task

### Task 3: `~/.ssh/config` and `known_hosts` readers, fingerprints [model: sonnet]

**Files:**
- Create: `src/main/remote/ssh-config.ts`, `src/main/remote/known-hosts.ts`
- Create: `test/unit/ssh-config.test.ts`, `test/unit/known-hosts.test.ts`

- [ ] `resolveSshConfig(host, {home, user, read})`: `Host` patterns (`*`, `?`, `!`, several per line), first value
      wins, `Include` relative to `~/.ssh` with globs and depth 4, keywords `HostName`, `User`, `Port`, `IdentityFile`
      (`~`, `%d`, `%u`, `%h`, `%r`; another `%` token ignores the line), `IdentitiesOnly`, `ProxyJump` /
      `ProxyCommand` reported as `jump: true`; `Match` skipped with `matchSkipped: true`; files capped (256 KiB)
- [ ] `fingerprint(keyBlob)`: `SHA256:` + unpadded base64 as `ssh-keygen -l`; `checkKnownHosts(host, port, type, blob,
      text)` → `trusted | changed | revoked | unknown`: plain and hashed `|1|salt|hash` entries, `[host]:port` for
      ports other than 22, comma lists, negated patterns, `@revoked`; `@cert-authority` lines ignored
- [ ] tests for config (patterns, negation, first wins, Include loop and depth, tokens, Match, missing file)
- [ ] tests for known_hosts (plain, hashed, port form, changed key, revoked, other key type is unknown) and the
      fingerprint against a fixed `ssh-keygen -l` output
- [ ] run tests - must pass before next task

### Task 4: `SshLink`: connection, sign-in, host key, commands, owned tunnel [model: opus]

**Files:**
- Create: `src/main/remote/ssh-link.ts`
- Create: `test/unit/ssh-link.test.ts`
- Modify: `src/shared/remote-servers.ts` (move `remoteCommand` use only if needed)

- [ ] dial from the record plus the config (record wins); sign-in order of design §5.1 through `authHandler`
      (auto: agent if `SSH_AUTH_SOCK`, then config or default key files, a passphrase-locked key skipped and named;
      password: `password` then keyboard-interactive with exactly one echo-off prompt; key: that file and passphrase,
      no agent); key files read capped at 64 KiB, regular files only
- [ ] host verifier per design §5.3 (record key, then known_hosts, else a `need: hostKey` result carrying type,
      fingerprint and address); an answer is accepted only when it matches the key seen on that dial; changed key
      refuses with the design's text
- [ ] typed results: `need: password | passphrase` (with `again` after a wrong one), errors mapped to one plain line by
      `ssh2` level
- [ ] `serverStatus` and `addDeviceToken` over `exec` with `remoteCommand` (64 KiB cap, 20 s deadline; the same parsing
      and messages as `ssh-tunnel.ts` had: not server mode, old server, https refused, ccc missing, empty stdout)
- [ ] the tunnel: listener on `127.0.0.1` (saved port when free, else 0, the port reported), each socket piped to
      `forwardOut`; redial with backoff 1, 2, 4 … 30 s keeping the listener, sockets closed while down; auth or host
      key failure on redial stops and reports; `acquire` / `release` with 30 s grace; `dispose`
- [ ] tests against an in-process `ssh2` `Server`: each auth kind (fake agent socket, password, keyboard-interactive
      with one and with two prompts, key with and without passphrase, wrong secret → `again`), host key first use /
      known_hosts trusted / changed, exec status and add-device parsing and every error, forwarding to the gateway
      stand-in, server killed then restarted (same local port, page-side socket reconnects), release grace, dispose
- [ ] run tests - must pass before next task

### Task 5: `RemoteService` on `SshLink`, My own tunnel, removal of the ssh spawn [model: opus]

**Files:**
- Modify: `src/main/remote/remote-service.ts`, `src/main/remote/remote-windows.ts` (waiting page), `src/main/index.ts`,
  `src/shared/ipc.ts` (`RemoteConnectRequest` per tab, `answers`, `need` results, `remote.edit`, `remote.pickKey`,
  `remote.suggestPort`, `remote.resolveHost`), `src/main/ipc/router.ts`
- Delete: `src/main/remote/ssh-process.ts`, `src/main/remote/ssh-tunnel.ts`, `test/unit/ssh-tunnel.test.ts`
- Modify: `test/unit/remote-service.test.ts`, grep tests that named `ssh-process.ts`

- [ ] replace `sshOver` / `SshTunnel` with `SshLink` behind the existing `RemoteTunnel` / `RemoteSsh` seams; connect and
      open return `need` results and accept `answers` (remember flag → store, else memory); background reconnect and
      re-pair never ask, they stop with the error
- [ ] `tunnel` kind: origin `http://127.0.0.1:<localPort>`; the pasted link's token only; before every load the
      no-cookie probe of `/auth/session` (2 s); nothing answers → main's waiting page with the `ssh -N -L` command and a
      3 s retry while the window is open; a non-cockpit answer → error, no load; a 403 from an old server → "update
      cc-cockpit on the server"
- [ ] new channels, all `REMOTE_CLASS` `no` and picker-only in the router: `remote.edit` (change a server's settings,
      keep cookie and host key unless the host changed), `remote.pickKey` (native open dialog through
      `electron-dialog.ts`, starting in `~/.ssh`, returns a path), `remote.suggestPort` (a free local port), `remote.resolveHost` (the config's HostName, User, Port, key
      and `jump` for a host, for the form's hints);
      `remote.forget` also ends the link and clears memory secrets
- [ ] delete the spawn code and its tests; update the CLAUDE.md-referenced grep tests
- [ ] tests: need/answers round trip (host key, password with remember on and off, passphrase), wrong password asks
      once then errors, background redial does not ask, tunnel probe (nothing, non-cockpit, cockpit, old server), Edit
      keeps the cookie, Forget ends the link; channels refused from a non-picker caller and from a remote view
- [ ] run tests - must pass before next task

### Task 6: Picker: three-tab form, prompts, Edit [model: opus]

**Files:**
- Modify: `src/renderer/picker/connect-form.tsx`, `servers-section.tsx`, `ProjectPicker.tsx`, `styles.css`
- Create: `src/renderer/picker/remote-prompts.tsx`
- Modify: unit tests of the picker model if any change

- [ ] form tabs SSH / My own tunnel / Link per design §3: SSH fields (host, user, port, sign in with, key path with
      Browse, passphrase, password, Remember, Advanced ccc); config hints from `remote.resolveHost` incl. the
      jump-host line; own tunnel
      fields with the two live commands (copy buttons) and the link field; Link tab as now
- [ ] prompts: Trust this host (address, type, fingerprint, the `ssh-keygen -lf` hint, Trust and Cancel, no default
      button, Enter blocked, armed after about a second like `ApprovalDialog`); Password / Passphrase (masked,
      Remember); calls `remote.connect` / `remote.open` again with `answers`
- [ ] server row: label per kind (`ssh user@host`, `tunnel :7331`, origin), Edit in the menu, "not remembered: no
      keyring" kept
- [ ] e2e-facing test ids on the new controls; unit tests for any pure helpers (command text building)
- [ ] run tests - must pass before next task

### Task 7: e2e: built-in SSH and My own tunnel [model: sonnet]

**Files:**
- Create: `test/fixtures/ssh-server.mjs`
- Delete: `test/fixtures/fake-ssh.mjs`
- Modify: `test/e2e/remote-desktop.spec.ts`

- [ ] `ssh-server.mjs`: an `ssh2` `Server` on a random loopback port (prints it), a host key made per run, password and
      public-key auth from args, `exec` runs the command locally with `sh -c` (env `CCC` pointing at the server's
      wrapper), `direct-tcpip` connects locally; `HOME` for the desktop app set to a temp dir with an empty
      `known_hosts`
- [ ] built-in SSH: Trust dialog shows the fixture's fingerprint, password prompt with Remember off, the project opens
      on a loopback origin, the device is named "cc-cockpit desktop on …"; a revoke re-pairs once; the fixture killed
      and restarted on the same port reconnects with no prompt; a relaunch asks the password again (not remembered),
      and with Remember on does not; a changed host key refuses
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
