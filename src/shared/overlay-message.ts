// The size cap on a message between an html overlay page and its plugin's host (ctx.overlay.start).
//
// Its own module, not src/sdk/panel-core.ts next to the panel cap: main and the host import this,
// and a module they share with the panel SDK lands in a common chunk that out/sdk/panel.js would
// load with `require`, which throws in a page (electron.vite.config.ts). Pure, no Node types: the
// renderer imports it too.

/**
 * Longest message either way, as JSON text. Unlike a panel's (1 MiB, straight over its port), such
 * a message is relayed by main and crosses the host RPC inside ONE message with its envelope
 * (method, plugin id, handle), and that transport is capped at 1 MiB (src/host/rpc.ts
 * MAX_RPC_MESSAGE_LENGTH). A message of the full panel cap would be refused there with an error
 * naming no limit, so overlays keep the same 8 KiB reserve as ctx.appStorage
 * (src/shared/plugin-storage.ts APP_RPC_RESERVE; a plugin id is at most 100 plain characters).
 */
export const MAX_OVERLAY_MESSAGE_LENGTH = 1024 * 1024 - 8 * 1024
