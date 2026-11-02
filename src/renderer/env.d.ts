import type { CockpitApi } from '../shared/ipc'

declare global {
  interface Window {
    /** The preload bridge (src/preload/index.ts); the renderer's only way to reach main. */
    cockpit: CockpitApi
  }
}

export {}
