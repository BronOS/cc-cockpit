import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Build layout (the rest of the app, the ccc wrapper and the plugin host spawner rely on it):
//   out/main/index.js      Electron main
//   out/main/mirror-worker.js  web access's headless terminals, a worker_threads entry main starts
//                          from its own folder (src/main/terminals/mirror-worker.ts); it requires
//                          @xterm/headless and the addons from node_modules, never main code
//   out/cli/index.js       the `ccc` CLI (run as Node by the generated wrapper)
//   out/host/index.js      plugin host (utilityProcess entry)
//   out/sdk/panel.js       the panel SDK, a classic browser script served at
//                          cc-plugin://<id>/__sdk/panel.js (src/sdk/panel.ts: no import/export
//                          of its own, so the CommonJS output has no `require`/`exports` in it;
//                          wrapped in a function by the banner/footer below)
//   out/preload/index.js   renderer bridge
//   out/renderer/          shell UI
//   out/renderer/web/      the web shell (design-web.md §2): the same React shell with the socket
//                          bridge (src/renderer/web/) instead of the preload, a second input of the
//                          renderer build so both share one set of chunks under out/renderer/assets;
//                          the web access gateway serves it to a browser
// cli and host are extra Node entries of the main build: they share main's Node target and
// externalisation rules, and their input keys carry the directory so one `outDir: out` yields
// the three folders above.
// Compiled into the main bundles (src/shared/app-version.ts): `ccc` runs as plain Node, where
// app.getVersion() does not exist, and compares this with the version the running app reports.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(version) },
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
          'cli/index': resolve(__dirname, 'src/cli/index.ts'),
          'host/index': resolve(__dirname, 'src/host/index.ts'),
          'sdk/panel': resolve(__dirname, 'src/sdk/panel.ts')
        },
        // node-pty is a native module (rebuilt for the Electron ABI in postinstall); it cannot be
        // bundled and must be loaded from node_modules at run time.
        external: ['node-pty'],
        output: {
          entryFileNames: '[name].js',
          // The panel SDK runs as a classic script in plugin pages: wrapped in a function, its
          // top-level names stay out of the page's global scope (a plugin script declaring its own
          // `client` or `PanelClient` would otherwise collide with them).
          banner: (chunk) => (chunk.name === 'sdk/panel' ? '(() => {' : ''),
          footer: (chunk) => (chunk.name === 'sdk/panel' ? '})();' : '')
        }
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
