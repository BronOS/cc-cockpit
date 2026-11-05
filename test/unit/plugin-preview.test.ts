// The placeholder and own-file URL of a plugin card's preview (design-next §6.1).
import { describe, expect, it } from 'vitest'
import { ownPreviewUrl, previewInitial } from '../../src/renderer/settings/plugin-preview'

describe('previewInitial', () => {
  it('is the first character upper-cased, a whole code point, or ? for a blank name', () => {
    expect(previewInitial('jira')).toBe('J')
    expect(previewInitial('  gmail')).toBe('G')
    expect(previewInitial('ßig')).toBe('SS')
    expect(previewInitial('🦊 fox')).toBe('🦊')
    expect(previewInitial('   ')).toBe('?')
    expect(previewInitial('')).toBe('?')
  })
})

describe('ownPreviewUrl', () => {
  it('is the plugin root preview.png on the plugin protocol', () => {
    expect(ownPreviewUrl('example.hello')).toBe('cc-plugin://example.hello/preview.png')
  })
})
