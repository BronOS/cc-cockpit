// The file tab's language by file name (src/page/languages.mjs): the v1 set of design-editor.md §1.
import test from 'node:test'
import assert from 'node:assert/strict'
import { languageOf, languageOfText } from '../src/page/languages.mjs'

test('the v1 languages by extension, case-insensitive, on the last path part', () => {
  const cases = {
    'src/a.ts': 'ts', 'a.TSX': 'tsx', 'b.mjs': 'js', 'c.jsx': 'jsx', 'x.cts': 'ts',
    'main.go': 'go', 'index.php': 'php', 'app.py': 'python', 'stub.pyi': 'python',
    'package.json': 'json', 'tsconfig.jsonc': 'json', 'ci.yml': 'yaml', 'k.yaml': 'yaml',
    'README.md': 'markdown', 'page.html': 'html', 'site.css': 'css', 'deploy.sh': 'shell', 'x.zsh': 'shell',
  }
  for (const [p, lang] of Object.entries(cases)) assert.equal(languageOf(p), lang, p)
})

test('dot files: shell rc files by name, a leading dot is not an extension', () => {
  assert.equal(languageOf('home/.bashrc'), 'shell')
  assert.equal(languageOf('.zshrc'), 'shell')
  assert.equal(languageOf('.env'), null)
  assert.equal(languageOf('.eslintrc'), 'json')
  assert.equal(languageOf('Makefile'), null)
  assert.equal(languageOf('dir.ts/file'), null)
  assert.equal(languageOf(undefined), null)
})

test('a script with no extension by its #! line', () => {
  assert.equal(languageOfText('bin/run', '#!/bin/sh'), 'shell')
  assert.equal(languageOfText('bin/run', '#!/usr/bin/env bash'), 'shell')
  assert.equal(languageOfText('bin/run', '#!/usr/bin/env python3'), 'python')
  assert.equal(languageOfText('bin/run', '#!/usr/bin/env node'), 'js')
  assert.equal(languageOfText('bin/run', 'echo hi'), null)
  // The name wins over the first line.
  assert.equal(languageOfText('a.ts', '#!/bin/sh'), 'ts')
})
