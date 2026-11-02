// Scriptable PtyBackend for unit tests: the test drives output and exit by hand and inspects
// what the code under test wrote, resized, paused or killed.
import type { PtyBackend, PtyHandle, PtySpawnOptions } from '../../src/main/pty/pty-backend'

export class FakePty implements PtyHandle {
  writes: string[] = []
  resizes: Array<[number, number]> = []
  killed = 0
  /** The signal of every kill() call, in order (undefined = the default SIGHUP). */
  signals: Array<string | undefined> = []
  paused = false
  /** Number of pause() / resume() calls, to catch thrashing. */
  pauseCalls = 0
  resumeCalls = 0
  exited = false
  /** Script: the child traps SIGHUP, so only SIGKILL ends it (`alive()`). */
  ignoresHup = false
  /** Ended by a signal (no exit event: the test emits that with `exit()` when it wants one). */
  private signalled = false
  private dataCb: (data: string) => void = () => {}
  private exitCb: (code: number, signal: number | null) => void = () => {}

  constructor(
    readonly argv: string[],
    readonly options: PtySpawnOptions
  ) {}

  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(signal?: 'SIGHUP' | 'SIGKILL'): void {
    this.killed++
    this.signals.push(signal)
    if (signal === 'SIGKILL' || !this.ignoresHup) this.signalled = true
  }
  alive(): boolean {
    return !this.exited && !this.signalled
  }
  pause(): void {
    this.paused = true
    this.pauseCalls++
  }
  resume(): void {
    this.paused = false
    this.resumeCalls++
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (code: number, signal: number | null) => void): void {
    this.exitCb = cb
  }

  /** Script: the child printed `data`. */
  emit(data: string): void {
    this.dataCb(data)
  }
  /** Script: the child ended. */
  exit(code: number, signal: number | null = null): void {
    this.exited = true
    this.exitCb(code, signal)
  }
}

export class FakePtyBackend implements PtyBackend {
  readonly spawned: FakePty[] = []
  /** Set to make the next spawn throw, like a missing executable. */
  failWith: Error | null = null

  spawn(argv: string[], options: PtySpawnOptions): FakePty {
    if (this.failWith) {
      const err = this.failWith
      this.failWith = null
      throw err
    }
    const pty = new FakePty(argv, options)
    this.spawned.push(pty)
    return pty
  }

  get last(): FakePty {
    const pty = this.spawned.at(-1)
    if (!pty) throw new Error('nothing spawned')
    return pty
  }
}
