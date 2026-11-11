import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { parseArgs, USAGE, usageFor } from '../../src/cli/args'
import { run } from '../../src/cli/client'
import { GUIDE_TOPICS, guideText } from '../../src/cli/guide'
import { MAX_SKILL_BYTES, MAX_SKILL_DEPTH, MAX_SKILL_DESCRIPTION, MAX_SKILL_DIRS, MAX_SKILL_ENTRIES, MAX_SKILL_FILES } from '../../src/main/plugins/skill-files'
import { MAX_SKILLS } from '../../src/shared/manifest'
import { RUNNABLE_EXTENSIONS } from '../../src/shared/runnable-files'
import { MAX_APP_VALUE_LENGTH, MAX_KEY_LENGTH, MAX_TOTAL_LENGTH, MAX_VALUE_LENGTH } from '../../src/shared/plugin-storage'
import { MAX_FILES } from '../../src/main/sessions/status-reducer'
import { FLAG_COLORS, MAX_FLAG_NOTE_CHARS } from '../../src/shared/tab-flag'
import { MAX_NOTIFICATIONS_PER_WINDOW, NOTIFY_WINDOW_MS } from '../../src/main/plugins/host-manager'
import {
  MAX_NOTIFY_ACTION_LABEL,
  MAX_NOTIFY_TEXT,
  MAX_NOTIFY_TITLE,
  NOTIFY_ACTION_WAIT_MS,
  NOTIFY_CHIME_INTERVAL_MS
} from '../../src/shared/notify'
import { BUILTIN_SOUNDS, MAX_SOUND_ID_LENGTH } from '../../src/shared/notify-sound'
import { DISPATCH_VIEW_MS } from '../../src/host/ctx/origin-view'

function capture(): { out: { stdout: (t: string) => void; stderr: (t: string) => void }; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { out: { stdout: (t) => void stdout.push(t), stderr: (t) => void stderr.push(t) }, stdout, stderr }
}

const topic = (name: string): string => GUIDE_TOPICS.find((t) => t.name === name)?.text ?? ''

describe('ccc guide', () => {
  it('has the planned topics', () => {
    expect(GUIDE_TOPICS.map((t) => t.name)).toEqual([
      'overview',
      'cli',
      'plugins',
      'api',
      'panels',
      'style',
      'settings-secrets',
      'dev-loop',
      'webview',
      'types'
    ])
  })

  it.each(GUIDE_TOPICS.filter((t) => t.name !== 'types').map((t) => t.name))('renders the %s topic', (name) => {
    const text = guideText(name)
    expect(text).toBeDefined()
    expect((text as string).length).toBeGreaterThan(200)
    expect(text).toMatch(/^# /)
  })

  it('prints the SDK types byte for byte, lists the topic, and keeps the example copy equal', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'sdk', 'types.ts'), 'utf8')
    expect(guideText('types')).toBe(source)
    expect(guideText()).toContain('  types')
    expect(source).toContain('PluginContext')
    expect(readFileSync(join(__dirname, '..', '..', 'examples', 'plugin', 'sdk', 'types.ts'), 'utf8')).toBe(source)
    expect(topic('plugins')).toContain('ccc guide types')
  })

  it('without a topic prints the overview and the topic list', () => {
    const text = guideText() as string
    expect(text).toContain('# cc-cockpit')
    for (const t of GUIDE_TOPICS) expect(text).toContain(t.name)
  })

  it('returns undefined for an unknown topic', () => {
    expect(guideText('nope')).toBeUndefined()
    expect(guideText('__proto__')).toBeUndefined()
  })

  it('parses guide, with at most one topic', () => {
    expect(parseArgs(['guide'])).toEqual({ kind: 'guide' })
    expect(parseArgs(['guide', 'api'])).toEqual({ kind: 'guide', topic: 'api' })
    expect(parseArgs(['guide', 'a', 'b']).kind).toBe('usage')
  })

  it('runs without the app: no socket, exit 0 with the text', async () => {
    const c = capture()
    // An env that points at a socket nobody listens on: the guide must not even look at it.
    const code = await run(['guide', 'cli'], { CC_COCKPIT_SOCK: '/nonexistent/sock' }, Readable.from([]), c.out)
    expect(code).toBe(0)
    expect(c.stdout.join('')).toBe(guideText('cli'))
  })

  it('exits 2 and lists the topics for an unknown topic', async () => {
    const c = capture()
    const code = await run(['guide', 'nope'], {}, Readable.from([]), c.out)
    expect(code).toBe(2)
    expect(c.stdout).toEqual([])
    expect(c.stderr.join('')).toContain('unknown guide topic: nope')
    expect(c.stderr.join('')).toContain('dev-loop')
  })
})

describe('ccc <command> --help', () => {
  it.each(['open', 'session', 'overlay', 'sessions', 'notify', 'guide', 'web', 'help'])('prints the usage of %s', async (command) => {
    expect(parseArgs([command, '--help'])).toEqual({ kind: 'help', command })
    const c = capture()
    const code = await run([command, '-h'], {}, Readable.from([]), c.out)
    expect(code).toBe(0)
    expect(c.stdout.join('')).toBe(`${usageFor(command)}\n`)
    expect(c.stderr).toEqual([])
  })

  it('prints only that command, including its continuation lines', () => {
    const overlay = usageFor('overlay') as string
    expect(overlay.split('\n').length).toBeGreaterThan(3)
    expect(overlay).not.toContain('ccc notify')
    expect(usageFor('notify')).toBe('  ccc notify <text>                        show a system notification')
  })

  it('does not run the command (notify --help sends nothing)', () => {
    expect(parseArgs(['notify', '--help']).kind).toBe('help')
  })

  it('leaves hook alone and falls through for unknown commands', () => {
    expect(parseArgs(['hook', '--help'])).toEqual({ kind: 'none' })
    expect(parseArgs(['Bogus', '--help']).kind).toBe('usage')
    // A plugin command's --help is the plugin's (its declared usage, fetched from main).
    expect(parseArgs(['bogus', '--help'])).toEqual({ kind: 'plugin', name: 'bogus', argv: ['--help'] })
  })
})

describe('guide drift guards', () => {
  it('names every command of USAGE in the cli topic', () => {
    const commands = new Set([...USAGE.matchAll(/^ {2}ccc (\S+)/gm)].map((m) => m[1] as string))
    expect(commands.size).toBeGreaterThanOrEqual(7)
    for (const c of commands) expect(topic('cli'), `ccc ${c}`).toContain(`ccc ${c}`)
    // `hook` and `statusline` are internal and have no USAGE line but the guide says so; keep them documented.
    expect(topic('cli')).toContain('ccc hook')
    expect(topic('cli')).toContain('ccc statusline')
  })

  it('names every ccc web subcommand of USAGE in the cli topic', () => {
    const subs = new Set([...USAGE.matchAll(/^ {2}ccc web (\S+)/gm)].map((m) => m[1] as string))
    expect([...subs].sort()).toEqual(['add-device', 'link', 'mode', 'password', 'revoke', 'set', 'status', 'stop'])
    for (const sub of subs) expect(topic('cli'), `ccc web ${sub}`).toContain(`ccc web ${sub}`)
  })

  it('names every ctx member of src/sdk/types.ts in the api topic', () => {
    const src = readFileSync(new URL('../../src/sdk/types.ts', import.meta.url), 'utf8')
    const body = /export interface PluginContext \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
    // Top level: two-space-indented members. Nested (panels, overlay, sessions, commands): four.
    const top = [...body.matchAll(/^ {2}(?:readonly )?(\w+)/gm)].map((m) => m[1] as string)
    const nested = [...body.matchAll(/^ {4}(\w+)\(/gm)].map((m) => m[1] as string)
    expect(top.length).toBeGreaterThan(15)
    expect(nested.length).toBeGreaterThan(5)
    const api = topic('api')
    for (const name of top) expect(api, `ctx.${name}`).toContain(`ctx.${name}`)
    for (const name of nested) expect(api, name).toMatch(new RegExp(`\\b${name}\\b`))

    // The helper objects' own methods (storage, secrets, oauth, logger, settings).
    for (const iface of ['PluginStorage', 'PluginAppStorage', 'PluginSecrets', 'PluginOAuth', 'PluginLogger', 'PluginSettings']) {
      const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ?? ''
      const names = [...m.matchAll(/^ {2}(?:readonly )?(\w+)/gm)].map((x) => x[1] as string)
      expect(names.length, iface).toBeGreaterThan(0)
      for (const name of names) expect(api, `${iface}.${name}`).toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('lists every extension ctx.files.openWithSystem refuses (shared/runnable-files.ts), and no other', () => {
    const api = topic('api').replace(/\s+/g, ' ')
    const para = /`ctx\.files\.openWithSystem\(path\)`(.*?)- `ctx\.files\.trash/.exec(api)?.[1] ?? ''
    const listed = [...para.matchAll(/`(\.[A-Za-z0-9]+)`/g)].map((m) => (m[1] as string).toLowerCase()).filter((e) => e !== '.app')
    expect([...listed].sort()).toEqual([...RUNNABLE_EXTENSIONS].sort())
  })

  it('names every SessionInfo and SessionSummary field in the api topic, and the flag rules from shared/tab-flag.ts', () => {
    const src = readFileSync(new URL('../../src/sdk/types.ts', import.meta.url), 'utf8')
    const api = topic('api').replace(/\s+/g, ' ')
    for (const iface of ['SessionInfo', 'SessionSummary']) {
      const body = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ?? ''
      const names = [...body.matchAll(/^ {2}readonly (\w+)/gm)].map((m) => m[1] as string)
      expect(names.length, iface).toBeGreaterThan(5)
      for (const name of names) expect(api, `${iface}.${name}`).toMatch(new RegExp(`\\b${name}\\b`))
    }
    // The flag: its colours (in the api and panels topics, with their tokens), its note limit, read-only.
    expect(api).toContain(FLAG_COLORS.map((c) => `\`${c}\``).join(', '))
    expect(api).toContain(`1 to ${MAX_FLAG_NOTE_CHARS} characters`)
    expect(api).toContain('no plugin API writes it')
    const panels = topic('panels').replace(/\s+/g, ' ')
    expect(panels).toContain('--cc-flag-red')
    for (const c of FLAG_COLORS.slice(1)) expect(panels).toContain(`\`-${c}\``)
  })

  // Bundled reviewer/editor plan Task 6 (reviewer FRICTION.md): the services members and the
  // limits a plugin author asked about, stated from the code so a changed constant fails here.
  it('names every ServicesApi member in the api topic', () => {
    const src = readFileSync(new URL('../../src/sdk/types.ts', import.meta.url), 'utf8')
    const body = /export interface ServicesApi \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
    const names = [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1] as string)
    expect(names).toContain('available')
    for (const name of names) expect(topic('api'), name).toContain(`ctx.services.${name}(`)
  })

  it('states the storage limits of plugin-storage.ts and the session files cap in the api topic', () => {
    const api = topic('api').replace(/\s+/g, ' ')
    const MiB = 1024 * 1024
    expect(api).toContain(`at most ${MAX_KEY_LENGTH} characters`)
    expect(api).toContain(`a value at most ${MAX_VALUE_LENGTH / MiB} MiB as JSON`)
    expect(api).toContain(`at most ${MAX_TOTAL_LENGTH / MiB} MiB in total`)
    expect(MAX_VALUE_LENGTH - MAX_APP_VALUE_LENGTH).toBe(8 * 1024)
    expect(api).toContain('Values at most 1 MiB less 8 KiB as JSON')
    expect(api).toContain(`capped at ${MAX_FILES}`)
  })

  it('states the origin view cap of origin-view.ts, waits included, in the api topic', () => {
    const api = topic('api').replace(/\s+/g, ' ')
    const seconds = DISPATCH_VIEW_MS / 1000
    expect(api).toContain(`(${seconds} s cap)`)
    // A command awaiting an overlay past the cap loses its view (review phase 4): the guide says so.
    expect(api).toContain(`The ${seconds} s cap counts from the click, waits included`)
    expect(api).toContain('shows on the desktop')
  })

  it('states the skill limits of skill-files.ts and manifest.ts in the plugins topic and docs/design.md', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ')
    const plugins = flat(topic('plugins'))
    const design = flat(readFileSync(new URL('../../docs/design.md', import.meta.url), 'utf8'))
    const copyLimits = [
      `${MAX_SKILL_FILES} files`,
      `${MAX_SKILL_BYTES / (1024 * 1024)} MiB`,
      `${MAX_SKILL_DIRS} folders`,
      `${MAX_SKILL_ENTRIES} directory entries`,
      `${MAX_SKILL_DEPTH} folders deep`,
      `at most ${MAX_SKILL_DESCRIPTION} chars`
    ]
    for (const limit of copyLimits) {
      expect(plugins, `guide plugins: ${limit}`).toContain(limit)
      expect(design, `design.md: ${limit}`).toContain(limit)
    }
    expect(plugins).toContain(`at most ${MAX_SKILLS} per plugin`)
  })

  it('states the ctx.notify limits of shared/notify.ts and host-manager.ts in the api topic and docs/design.md', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ')
    const api = flat(topic('api'))
    const design = flat(readFileSync(new URL('../../docs/design.md', import.meta.url), 'utf8'))
    expect(NOTIFY_WINDOW_MS).toBe(60_000)
    for (const text of [api, design]) {
      expect(text).toContain(`cut at ${MAX_NOTIFY_TEXT} characters`)
      expect(text).toContain(`1 to ${MAX_NOTIFY_TITLE} characters`)
      expect(text).toContain(`1 to ${MAX_NOTIFY_ACTION_LABEL} characters`)
      expect(text).toContain(`after ${NOTIFY_ACTION_WAIT_MS / 60_000} minutes`)
      expect(text).toContain(`one chime per ${NOTIFY_CHIME_INTERVAL_MS / 1000} s per window`)
    }
    expect(api).toContain(`at most ${MAX_NOTIFICATIONS_PER_WINDOW} a minute`)
    expect(design).toContain(`at most ${MAX_NOTIFICATIONS_PER_WINDOW} per minute`)
  })

  it('documents the "format": "sound" field with every built-in id, in the settings topic and docs/design.md', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ')
    const settings = flat(topic('settings-secrets'))
    const design = flat(readFileSync(new URL('../../docs/design.md', import.meta.url), 'utf8'))
    for (const text of [settings, design]) {
      expect(text).toContain('"format": "sound"')
      expect(text).toContain('"App default"')
      // The ids a plugin may give as the field's default (validate.ts isSoundFieldDefault).
      for (const s of BUILTIN_SOUNDS) expect(text).toContain(`\`builtin:${s.name}\``)
    }
    // ctx.notify's sound id, in the api topic and the SDK types.
    const api = flat(topic('api'))
    expect(api).toContain('`sound: "<id>"`')
    expect(flat(readFileSync(new URL('../../src/sdk/types.ts', import.meta.url), 'utf8'))).toContain(
      `At most ${MAX_SOUND_ID_LENGTH} characters`
    )
    expect(design).toContain(`a sound id of at most ${MAX_SOUND_ID_LENGTH} characters`)
  })

  it('documents the panel SDK members', () => {
    for (const member of ['ccPanel.post', 'ccPanel.onMessage', 'theme.current', 'theme.onChange', 'ccPanel.view.remote']) {
      expect(topic('panels')).toContain(member)
    }
  })
})

describe('style topic drift guard', () => {
  const classes = (text: string): Set<string> =>
    new Set(Array.from(text.matchAll(/\.(cc-[a-z][a-z-]*)/g), (m) => m[1] as string))
  // The comments name classes in prose (`cc-shell` is the shell's own marker, not a component).
  const css = readFileSync(join(__dirname, '..', '..', 'src', 'sdk', 'components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const cssClasses = classes(css)
  cssClasses.delete('cc-shell')
  // In the guide a class appears as `.cc-x` in prose and as `class="cc-x ..."` in the examples.
  const guide = topic('style')
  const guideClasses = classes(guide)
  for (const m of guide.matchAll(/class="([^"]+)"/g)) {
    for (const c of (m[1] as string).split(/\s+/)) if (c.startsWith('cc-')) guideClasses.add(c)
  }

  it('documents every class of components.css', () => {
    expect(cssClasses.size).toBeGreaterThan(20)
    for (const c of cssClasses) expect(guideClasses, c).toContain(c)
  })

  it('names no class that components.css lacks', () => {
    for (const c of guideClasses) expect(cssClasses, c).toContain(c)
  })

  it('prints through ccc guide style', () => {
    expect(guideText('style')).toContain('# Style: the component stylesheet')
    expect(guideText()).toContain('  style')
  })
})
