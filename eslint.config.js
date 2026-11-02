// CommonJS on purpose: package.json has no "type": "module" (the Electron main and preload
// bundles must stay CommonJS for the sandboxed preload).
const js = require('@eslint/js')
const globals = require('globals')
const tseslint = require('typescript-eslint')
const reactHooks = require('eslint-plugin-react-hooks')

module.exports = tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'plugins/hello/dist/**', 'plugins/browser/dist/**', 'plugins/reviewer/dist/**', 'plugins/editor/dist/**', 'plugins/reviewer/overlay/*.bundle.js', 'plugins/reviewer/src/**', 'plugins/*/test/**', 'examples/plugin/dist/**', 'marketplace/tools/dist/**', 'release/**', '.vite/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // IPC authority: every handler goes through IpcRouter (src/main/ipc/router.ts), which checks
    // the sender before any handler runs. A direct `ipcMain.handle`/`ipcMain.on` elsewhere in main
    // would skip that check, so only the entry file, which hands ipcMain to the router, may
    // import it.
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              importNames: ['ipcMain'],
              message: 'Register IPC handlers through IpcRouter (src/main/ipc/router.ts).'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    // Build scripts (scripts/build-hello.mjs) are ES modules run by Node.
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' }
  },
  {
    // .cjs too: scripts/render-icon.cjs runs under Electron as CommonJS (Electron's main entry).
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
)
