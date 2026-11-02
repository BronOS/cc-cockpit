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
