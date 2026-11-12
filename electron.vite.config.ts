import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { build, type Plugin } from 'vite'

// Build layout (the rest of the app, the ccc wrapper and the plugin host spawner rely on it):
//   out/main/index.js      Electron main
//   out/main/mirror-worker.js  web access's headless terminals, a worker_threads entry main starts
//                          from its own folder (src/main/terminals/mirror-worker.ts); it requires
//                          @xterm/headless and the addons from node_modules, never main code
//   out/main/ssh-client.js the ssh2 adapter (src/main/remote/ssh-client.ts) with ssh2 bundled in, its
//                          own entry so scripts/ssh2-electron-check.mjs can load exactly the bytes
//                          that ship (in out/ and in a packaged app.asar); main imports it like any module
//   out/cli/index.js       the `ccc` CLI (run as Node by the generated wrapper)
//   out/host/index.js      plugin host (utilityProcess entry)
//   out/sdk/panel.js       the panel SDK, a classic browser script served at
//                          cc-plugin://<id>/__sdk/panel.js; its own build (panelSdk below), not
//                          an entry of the main build
//   out/preload/index.js   renderer bridge
//   out/renderer/          shell UI
//   out/renderer/web/      the web shell (design-web.md §2): the same React shell with the socket
//                          bridge (src/renderer/web/) instead of the preload, a second input of the
//                          renderer build so both share one set of chunks under out/renderer/assets;
//                          the web access gateway serves it to a browser
// cli, host and the main/ entries are Node entries of the main build: they share main's Node target and
// externalisation rules, and their input keys carry the directory so one `outDir: out` yields
// the three folders above. The Node entries may share chunks under out/chunks (rolldown's runtime
// helpers among them, since ssh2 is CommonJS): fine for Node, never for the panel SDK.
// Compiled into the main bundles (src/shared/app-version.ts): `ccc` runs as plain Node, where
// app.getVersion() does not exist, and compares this with the version the running app reports.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

// The panel SDK (src/sdk/panel.ts) is a classic script in plugin pages: no module system, so no
// `require`. It used to be one more entry of the main build, with nothing but care keeping it free of
// shared chunks; bundling ssh2 (CommonJS) made rolldown move its runtime helpers into a shared
// out/chunks/rolldown-runtime-*.js that every entry, panel.js included, loaded with `require`, and
// every plugin panel stopped talking to its host. Rolldown has no option to inline the runtime per
// entry, and folding ssh-client back into main only hides the trigger, so the SDK gets a build of its
// own: one input, IIFE output (a function wrapper, so its top-level names stay out of the page's
// global scope: a plugin script declaring its own `client` or `PanelClient` would collide), nothing
// to share a chunk with. It runs when the main build closes (electron-vite builds main first and
// main's emptyOutDir has run by then), so `electron-vite build` and `dev` both write it. The check
// after it fails the build if the file ever imports or requires anything again.
const PANEL_SDK_OUT = resolve(__dirname, 'out/sdk')
const panelSdk: Plugin = {
  name: 'cc-panel-sdk',
  async closeBundle() {
    const result = await build({
      configFile: false,
      root: __dirname,
      publicDir: false,
      logLevel: 'warn',
      build: {
        outDir: PANEL_SDK_OUT,
        emptyOutDir: false,
        minify: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: resolve(__dirname, 'src/sdk/panel.ts'),
          output: { format: 'iife', entryFileNames: 'panel.js' }
        }
      }
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []))
    const chunks = outputs.filter((o) => o.type === 'chunk')
    const sdk = chunks.find((c) => c.fileName === 'panel.js')
    if (!sdk || chunks.length !== 1 || sdk.imports.length || sdk.dynamicImports.length || sdk.code.includes('require(')) {
      throw new Error('out/sdk/panel.js must be one classic script with no imports and no require(): see electron.vite.config.ts')
    }
  }
}

// ssh2 (design-remote-desktop.md §8 "The library") is a devDependency, so electron-vite bundles it
// into main instead of leaving a `require('ssh2')` that would need it shipped in node_modules. Its two
// optional native parts are never bundled and never loaded: `cpu-features` (only reorders the cipher
// list) and lib/protocol/crypto/build/Release/sshcrypto.node (ssh2's install script builds it with
// node-gyp for plain Node, so it would be the wrong ABI for Electron, and electron-builder neither
// ships nor rebuilds a devDependency's native module). ssh2 requires both inside try/catch and falls
// back to plain JS, so each is resolved to a stub that throws: the fallback is then taken in dev and
// in the packaged app alike, where an `external` would leave a require that finds node_modules/
// cpu-features in a dev checkout but nothing in the package. Only requires from inside ssh2 are
// stubbed; any other `.node` import still fails the build.
const SSH2_NATIVE_STUB = '\0ssh2-native-absent'
const ssh2PureJs: Plugin = {
  name: 'cc-ssh2-pure-js',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !importer.split('\\').join('/').includes('/node_modules/ssh2/')) return null
    return source === 'cpu-features' || source.endsWith('.node') ? SSH2_NATIVE_STUB : null
  },
  load(id) {
    return id === SSH2_NATIVE_STUB ? "throw new Error('ssh2 native part not bundled: pure-JS path')" : null
  }
}

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [ssh2PureJs, panelSdk],
    build: {
      outDir: 'out',
      // Empties the whole of out/, including out/preload and out/renderer. That is only safe
      // because electron-vite builds main first. In watch mode (`electron-vite dev -w`) a main
      // rebuild would delete out/preload without rebuilding it: do not use main watch mode
      // without moving this clean-up into the `build` script.
      emptyOutDir: true,
      rollupOptions: {
        input: {
          'main/index': resolve(__dirname, 'src/main/index.ts'),
          'main/mirror-worker': resolve(__dirname, 'src/main/terminals/mirror-worker.ts'),
          'main/ssh-client': resolve(__dirname, 'src/main/remote/ssh-client.ts'),
          'cli/index': resolve(__dirname, 'src/cli/index.ts'),
          'host/index': resolve(__dirname, 'src/host/index.ts')
        },
        // node-pty is a native module (rebuilt for the Electron ABI in postinstall); it cannot be
        // bundled and must be loaded from node_modules at run time.
        external: ['node-pty'],
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          web: resolve(__dirname, 'src/renderer/web/index.html')
        }
      }
    }
  }
})
