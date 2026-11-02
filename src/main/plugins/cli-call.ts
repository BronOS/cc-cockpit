// One `ccc <plugin command>` call to a plugin host, with its deadline and its cancel (plan B
// Task 5). HostManager.runCli decides whether the call may start (the plugin runs in this window,
// declares the name, has a free slot) and counts it; this file only runs it: the `cli.run` RPC,
// the CLI_CALL_TIMEOUT_MS timer and the caller-gone signal, each of which ends the call once.
//
// No Electron import and no host state: unit tests drive it with a fake rpc and fake timers.
import { CLI_TIMEOUT_CODE, normalizeCliResult, type PluginCliResult } from '../../shared/plugin-cli'

/** The slice of RpcEndpoint a call needs. */
export interface CliRpc {
  call(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  emit(event: string, params?: unknown): void
}

export interface CliCallOptions {
  /** The command name, for the messages. */
  name: string
  /** Names this call in the host's `cli.cancel` event. */
  callId: number
  timeoutMs: number
  /**
   * The whole limit, for the timeout message, when `timeoutMs` is only what is left of it
   * (HostManager.runCli first waits for a plugin that is reloading). Default: `timeoutMs`.
   */
  limitMs?: number
  /** Aborts when the `ccc` caller went away (Ctrl+C closed its socket). */
  peerGone?: AbortSignal
}

/**
 * Send `cli.run` with `params` and settle with the first of:
 *   - the host's answer, normalized (re-capped: the host is not trusted to cap);
 *   - `timeoutMs`: exit CLI_TIMEOUT_CODE (124, as `timeout(1)`) with a message, the host told to cancel;
 *   - `peerGone`: rejected, the host told to cancel;
 *   - the RPC failing (the host exited, the endpoint closed): rejected with its error.
 * The `cli.cancel` event only aborts the handler's signal in the host; its late answer is dropped,
 * and so is the pending RPC entry (aborted once the call settled), so a host that never answers
 * does not leak one entry per timed-out call.
 */
export async function callCli(rpc: CliRpc, params: Record<string, unknown>, options: CliCallOptions): Promise<PluginCliResult> {
  const { name, callId, timeoutMs, peerGone } = options
  const limitMs = options.limitMs ?? timeoutMs
  if (peerGone?.aborted) throw new Error(`${name}: the caller went away`)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onGone: (() => void) | undefined
  const drop = new AbortController()
  try {
    return await new Promise<PluginCliResult>((resolve, reject) => {
      timer = setTimeout(() => {
        rpc.emit('cli.cancel', { callId })
        resolve({ stdout: '', stderr: `ccc ${name}: no answer within ${Math.round(limitMs / 1000)} s\n`, code: CLI_TIMEOUT_CODE })
      }, timeoutMs)
      onGone = () => {
        rpc.emit('cli.cancel', { callId })
        reject(new Error(`${name}: the caller went away`))
      }
      peerGone?.addEventListener('abort', onGone, { once: true })
      // No RPC timeout of its own: the timer above answers first, with the exit code `timeout(1)` uses.
      rpc
        .call('cli.run', { ...params, callId }, { timeoutMs: Infinity, signal: drop.signal })
        .then((value) => resolve(normalizeCliResult(value)), reject)
    })
  } finally {
    drop.abort()
    clearTimeout(timer)
    if (onGone) peerGone?.removeEventListener('abort', onGone)
  }
}
