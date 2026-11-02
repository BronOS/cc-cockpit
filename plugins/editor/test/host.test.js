'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { microArgv, relativePath } = require('../dist/host.js')

test('microArgv: options, file, line', () => {
  assert.deepEqual(microArgv({}, 'src/a.ts', 12), ['micro', '-autosave', '5', 'src/a.ts', '+12'])
  assert.deepEqual(microArgv({ autosaveSeconds: 0, colorscheme: 'gruvbox-tc', microPath: '/opt/micro' }, 'a', undefined), ['/opt/micro', '-autosave', '0', '-colorscheme', 'gruvbox-tc', 'a'])
  assert.deepEqual(microArgv({ colorscheme: 'bad name;rm' }, '-x.txt', 0), ['micro', '-autosave', '5', './-x.txt'])
})

test('relativePath refuses escapes', () => {
  assert.equal(relativePath('./a//b.txt'), 'a/b.txt')
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', '', '.']) assert.throws(() => relativePath(bad))
})

// A fake ctx: records what the host provides and starts.
function fakeCtx({ execResult }) {
  const provided = {}
  const cli = {}
  const started = []
  const ctx = {
    projectDir: '/proj',
    settings: { app: {} },
    exec: async () => {
      if (execResult instanceof Error) throw execResult
      return execResult
    },
    services: { provide: (n, impl) => (provided[n] = impl) },
    cli: { register: (n, fn) => (cli[n] = fn) },
    overlay: { start: (spec) => (started.push(spec), { result: new Promise(() => {}) }) },
    log: { info() {}, warn() {} },
  }
  return { ctx, provided, cli, started }
}

test('a missing micro names the install commands and the microPath setting', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: new Error('spawn micro ENOENT') })
  host.activate(f.ctx)
  await assert.rejects(f.provided.editor.open('a.txt'), (e) => {
    for (const w of ['brew install micro', 'sudo pacman -S micro', 'sudo apt install micro', 'https://micro-editor.github.io', 'microPath']) assert.ok(e.message.includes(w), w)
    return true
  })
  assert.equal(f.started.length, 0)
})

test('ccc edit resolves against ctx.projectDir', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  host.activate(f.ctx)
  const r = await f.cli.edit(['src/a.ts', '7'], { cwd: '/proj' })
  assert.equal(r.stdout, 'editing src/a.ts\n')
  assert.deepEqual(f.started[0].argv.slice(-2), ['src/a.ts', '+7'])
})
