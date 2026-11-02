import { useLayoutEffect } from 'react'
import { acquireLayer } from './shell-layers'

/**
 * Hold a shell layer (shell-layers.ts) while `active`. A layout effect: the layer is up before the
 * browser paints the menu or dialog, so the report hiding a webview leaves in the same frame.
 */
export function useShellLayer(active: boolean): void {
  useLayoutEffect(() => (active ? acquireLayer() : undefined), [active])
}
