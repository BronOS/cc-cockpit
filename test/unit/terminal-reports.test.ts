import { describe, expect, it } from 'vitest'
import { isPersonInput } from '../../src/main/sessions/terminal-reports'

const ESC = '\x1b'

// Every report xterm sends by itself (terminal-reports.ts header), one example or more per kind.
const REPORTS: Record<string, string[]> = {
  focus: [`${ESC}[I`, `${ESC}[O`],
  'mouse SGR': [`${ESC}[<0;12;7M`, `${ESC}[<0;12;7m`, `${ESC}[<64;1;1M`, `${ESC}[<65;200;50M`],
  // X10: button + 32, column + 32, row + 32 (a press at 1,1, and one past 0x7f in UTF-8 mode).
  'mouse X10': [`${ESC}[M !!`, `${ESC}[M#\u00c8\u00c8`],
  'cursor position': [`${ESC}[1;1R`, `${ESC}[24;80R`],
  'device attributes': [`${ESC}[?1;2c`, `${ESC}[?62;22c`, `${ESC}[>0;276;0c`, `${ESC}[?c`],
  DECRPM: [`${ESC}[?2004;1$y`, `${ESC}[?1049;2$y`, `${ESC}[4;2$y`],
  OSC: [`${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`, `${ESC}]10;rgb:ffff/ffff/ffff\x07`, `${ESC}]4;1;rgb:cdcd/0000/0000\x07`],
  DCS: [`${ESC}P1$r0m${ESC}\\`, `${ESC}P>|xterm.js(5.5.0)${ESC}\\`]
}

describe('isPersonInput: terminal reports alone are not the person', () => {
  for (const [kind, samples] of Object.entries(REPORTS)) {
    it(`${kind}: alone and repeated`, () => {
      for (const sample of samples) {
        expect(isPersonInput(sample), JSON.stringify(sample)).toBe(false)
        expect(isPersonInput(sample.repeat(3)), JSON.stringify(sample)).toBe(false)
      }
    })
  }

  it('several kinds back to back in one chunk', () => {
    expect(isPersonInput(Object.values(REPORTS).flat().join(''))).toBe(false)
    expect(isPersonInput(`${ESC}[I${ESC}[<0;3;4M${ESC}[<0;3;4m${ESC}[O`)).toBe(false)
  })

  it('an empty chunk', () => {
    expect(isPersonInput('')).toBe(false)
  })
})

describe('isPersonInput: what the person types or pastes', () => {
  it('a letter, Enter, Backspace, Tab, Esc, Ctrl+C, a digit', () => {
    for (const key of ['a', 'Z', '\r', '\x7f', '\t', ESC, '\x03', '1', ' ']) {
      expect(isPersonInput(key), JSON.stringify(key)).toBe(true)
    }
  })

  it('arrow keys, both cursor modes, and modified ones', () => {
    for (const key of [`${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`, `${ESC}OA`, `${ESC}OB`, `${ESC}[1;5C`, `${ESC}[H`, `${ESC}[3~`]) {
      expect(isPersonInput(key), JSON.stringify(key)).toBe(true)
    }
  })

  it('a mouse wheel in alt-screen (alternate scroll sends arrow keys) counts as typing', () => {
    // xterm turns the wheel into CSI A / CSI B (SS3 in application cursor mode) when no mouse
    // tracking is on. They are history keys in Claude's prompt, changing its input box, so a later
    // paste would be glued to what they brought up: typing on purpose (terminal-reports.ts).
    expect(isPersonInput(`${ESC}[A${ESC}[A${ESC}[A`)).toBe(true)
    expect(isPersonInput(`${ESC}OB${ESC}OB`)).toBe(true)
  })

  it('a paste, bracketed or not, and Alt+key', () => {
    expect(isPersonInput(`${ESC}[200~some pasted text${ESC}[201~`)).toBe(true)
    expect(isPersonInput('some pasted text\nwith lines')).toBe(true)
    expect(isPersonInput(`${ESC}b`)).toBe(true)
    // Alt+] and Alt+P start an OSC / DCS that never ends: not a reply.
    expect(isPersonInput(`${ESC}]`)).toBe(true)
    expect(isPersonInput(`${ESC}P`)).toBe(true)
  })

  it('a report glued to a key, on either side or between reports', () => {
    expect(isPersonInput(`${ESC}[Ix`)).toBe(true)
    expect(isPersonInput(`x${ESC}[I`)).toBe(true)
    expect(isPersonInput(`${ESC}[I\r${ESC}[O`)).toBe(true)
    expect(isPersonInput(`${ESC}[<0;1;1Ma`)).toBe(true)
    expect(isPersonInput(`${ESC}[24;80R${ESC}[A`)).toBe(true)
  })

  it('look-alikes that are not complete reports', () => {
    for (const chunk of [`${ESC}[`, `${ESC}[<0;1M`, `${ESC}[<0;1;1`, `${ESC}[M!!`, `${ESC}[12R`, `${ESC}[?1;2`, `${ESC}[?2004$y`, `${ESC}]11;rgb`, `${ESC}[<a;1;1M`]) {
      expect(isPersonInput(chunk), JSON.stringify(chunk)).toBe(true)
    }
  })
})
