import type { PowerSaveBackend } from '../../src/main/power/power-holds'

/**
 * Electron's powerSaveBlocker as the tests see it: every start a new id, every live id in `active`,
 * and the calls in order. A stop of an id that is not live is recorded but changes nothing, like
 * electron-power.ts (it checks isStarted first).
 */
export class FakePowerBackend implements PowerSaveBackend {
  readonly active = new Set<number>()
  readonly calls: Array<['start', number] | ['stop', number]> = []
  private next = 1

  start(): number {
    const id = this.next++
    this.active.add(id)
    this.calls.push(['start', id])
    return id
  }

  stop(id: number): void {
    this.calls.push(['stop', id])
    this.active.delete(id)
  }
}
