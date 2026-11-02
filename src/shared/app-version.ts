// The version this bundle was built from. electron.vite.config.ts replaces `__APP_VERSION__` with
// package.json's version in the main, CLI and host bundles. Tests run the sources unbundled, where
// the name does not exist, hence the `typeof` and the fallback.
declare const __APP_VERSION__: string | undefined

export const BUILD_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'
