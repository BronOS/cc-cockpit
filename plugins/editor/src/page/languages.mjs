// Which language a file tab highlights, by its name (design-editor.md §1: TS/JS, Go, PHP, Python,
// JSON, YAML, Markdown, HTML, CSS and shell in v1). A key, not a CodeMirror extension, so this file
// has no dependency and the node:test suite reads it as is; file.js turns the key into the language.

const BY_EXTENSION = {
  js: 'js', mjs: 'js', cjs: 'js',
  jsx: 'jsx',
  ts: 'ts', mts: 'ts', cts: 'ts',
  tsx: 'tsx',
  go: 'go',
  php: 'php', phtml: 'php',
  py: 'python', pyi: 'python', pyw: 'python',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'css', less: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell',
}

// Shell files that go by name, not extension (dot files of the shells, and a few tools' own).
const BY_NAME = {
  '.bashrc': 'shell', '.bash_profile': 'shell', '.bash_aliases': 'shell', '.bash_logout': 'shell',
  '.zshrc': 'shell', '.zshenv': 'shell', '.zprofile': 'shell', '.zlogin': 'shell', '.profile': 'shell',
  '.envrc': 'shell', 'pkgbuild': 'shell', '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json',
}

/**
 * The language key of a project-relative path (`src/a.ts` -> 'ts'), or null for plain text. Only
 * the last path part counts; case does not.
 */
export function languageOf(path) {
  if (typeof path !== 'string') return null
  const name = path.split('/').pop().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(BY_NAME, name)) return BY_NAME[name]
  const dot = name.lastIndexOf('.')
  // `.env` and the like: a leading dot is a hidden file, not an extension.
  if (dot <= 0) return null
  const ext = name.slice(dot + 1)
  return Object.prototype.hasOwnProperty.call(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null
}

/** A shell script with no extension says so in its first line (`#!/bin/sh`, `#!/usr/bin/env bash`). */
export function languageOfText(path, firstLine) {
  const byName = languageOf(path)
  if (byName) return byName
  if (typeof firstLine === 'string' && /^#!\s*\S*\b(?:env\s+)?(?:ba|z|k|da)?sh\b/.test(firstLine)) return 'shell'
  if (typeof firstLine === 'string' && /^#!\s*\S*\b(?:env\s+)?python[0-9.]*\b/.test(firstLine)) return 'python'
  if (typeof firstLine === 'string' && /^#!\s*\S*\b(?:env\s+)?node\b/.test(firstLine)) return 'js'
  return null
}
