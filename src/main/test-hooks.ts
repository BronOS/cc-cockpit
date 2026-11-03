// Hooks for the Playwright e2e suite to look inside main. Loaded ONLY when CC_COCKPIT_TEST=1,
// through a dynamic import in src/main/index.ts, so a normal run never even loads this file.
//
// Deliberately not IPC handlers: a renderer-reachable test channel would widen the production
// boundary (the preload allow-list in src/shared/ipc.ts exists to keep every page from reaching
// anything but the declared channels, and tests must not need a hole in it). The harness drives
// main with `electronApp.evaluate()`, which already runs inside main, so the hooks hang off a
// global there:
//     await app.evaluate((_, path) => globalThis.__ccTest.tabs(path), projectDir)
//
// What exists follows what main has: the tab list, setTheme, openProject, windowLook, socket, the session
// registry's entries, the send gate's send / cancelQueued, the zone layout (layout,
// pluginPanels, panelStatus), the overlay stack (openOverlay, overlayResult, overlays, focusOverlay),
// `ccc notify` and ctx.notify (notifications, notificationDetails, clickNotification,
// dismissNotification, chimes, chimeSounds) and the plugin hosts (linkPlugin, enablePlugin, hostStatus,
// savePluginProjectSettings, pluginCommands, runPluginCommand).

/** Name of the global the hooks hang off; fixtures.ts reads it. */
export const TEST_HOOKS_GLOBAL = '__ccTest'

export type TestHook = (...args: never[]) => unknown

/**
 * Publish `hooks` on `target` (globalThis in main). A name that is already taken is an error:
 * two tasks adding the same hook would otherwise silently shadow one another.
 */
export function installTestHooks(
  hooks: Record<string, TestHook>,
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): void {
  const existing = (target[TEST_HOOKS_GLOBAL] ??= {}) as Record<string, TestHook>
  for (const [name, hook] of Object.entries(hooks)) {
    if (name in existing) throw new Error(`test hook ${name} is already installed`)
    existing[name] = hook
  }
}
