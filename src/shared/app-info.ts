// Constants shared by main, the CLI and the plugin host. Kept free of Electron imports so unit
// tests (plain Node) and the CLI (Electron run as Node) can load it.

/** App name: also the name of the Electron userData folder (`~/Library/Application Support/cc-cockpit`). */
export const APP_NAME = 'cc-cockpit'

/** Name of the CLI the app generates into `<data>/bin/` (see Task 13). */
export const CLI_NAME = 'ccc'
