// Claude Code's harness blocks in a UserPromptSubmit prompt (src/main/sessions/harness-markup.ts):
// the samples are shaped like what the Sessions panel showed raw before the fix.
import { describe, expect, it } from 'vitest'
import { cleanHarnessMarkup } from '../../src/main/sessions/harness-markup'

describe('cleanHarnessMarkup', () => {
  it('leaves a plain prompt alone, markup-free or not', () => {
    expect(cleanHarnessMarkup('fix the failing test')).toBe('fix the failing test')
    expect(cleanHarnessMarkup('  keep my spacing  ')).toBe('  keep my spacing  ')
    // HTML the person typed is theirs, even with a closing tag.
    expect(cleanHarnessMarkup('make <div class="x">a</div> a <section>')).toBe('make <div class="x">a</div> a <section>')
    expect(cleanHarnessMarkup('a < b and c > d')).toBe('a < b and c > d')
  })

  it('treats a turn of harness blocks only as no prompt at all', () => {
    const notification = [
      '<task-notification>',
      '<task-id>bo1mom0zx</task-id>',
      '<tool-use-id>toolu_01LApYBh2ZSLey3mQX9E5em7</tool-use-id>',
      '<output-file>/tmp/claude-1000/x/tasks/bo1mom0zx.output</output-file>',
      '<status>completed</status>',
      '<summary>Background command "Run baseline unit tests" completed (exit code 0)</summary>',
      '</task-notification>'
    ].join('\n')
    expect(cleanHarnessMarkup(notification)).toBeUndefined()
    expect(
      cleanHarnessMarkup('<system-reminder>\nThe user opened the file src/a.ts in the IDE.\n</system-reminder>')
    ).toBeUndefined()
    expect(
      cleanHarnessMarkup('<agent-message from="worker-2" id="m1">\nDone: 3 files changed.\n</agent-message>')
    ).toBeUndefined()
    expect(
      cleanHarnessMarkup(
        '<local-command-stdout>Set model to haiku</local-command-stdout>\n<local-command-stderr></local-command-stderr>'
      )
    ).toBeUndefined()
    expect(cleanHarnessMarkup(`${notification}\n\n<system-reminder>x</system-reminder>\n`)).toBeUndefined()
  })

  it('keeps the person text of a mixed prompt and drops the blocks', () => {
    expect(
      cleanHarnessMarkup('<system-reminder>\nToday is 2026-11-02.\n</system-reminder>\nwhy does the build fail?')
    ).toBe('why does the build fail?')
    expect(
      cleanHarnessMarkup('look at this\n<user-prompt-submit-hook>branch: main</user-prompt-submit-hook>\n\n\n\nthanks')
    ).toBe('look at this\n\nthanks')
  })

  it('turns a slash command into /name args', () => {
    expect(
      cleanHarnessMarkup(
        '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>PR 42 --strict</command-args>'
      )
    ).toBe('/review PR 42 --strict')
    expect(
      cleanHarnessMarkup('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')
    ).toBe('/clear')
    // A name given without its slash still reads as a command.
    expect(cleanHarnessMarkup('<command-name>compact</command-name>')).toBe('/compact')
  })

  it('turns a shell command into ! input, without its output', () => {
    expect(
      cleanHarnessMarkup('<bash-input>git status</bash-input><bash-stdout>On branch master\nnothing to commit</bash-stdout><bash-stderr></bash-stderr>')
    ).toBe('! git status')
    // Its output alone (the second user turn of a `!` command) is not a prompt.
    expect(cleanHarnessMarkup('<bash-stdout>On branch master</bash-stdout><bash-stderr></bash-stderr>')).toBeUndefined()
  })

  it('keeps a known name the person wrote without a closer, and stays linear on many of them', () => {
    expect(cleanHarnessMarkup('what does <system-reminder> mean?')).toBe('what does <system-reminder> mean?')
    const many = 'x <system-reminder> '.repeat(50_000)
    const started = performance.now()
    expect(cleanHarnessMarkup(many)).toBe(many)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
