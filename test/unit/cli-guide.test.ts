import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { parseArgs, USAGE, usageFor } from '../../src/cli/args'
import { run } from '../../src/cli/client'
import { GUIDE_TOPICS, guideText } from '../../src/cli/guide'
import { MAX_SKILL_BYTES, MAX_SKILL_DEPTH, MAX_SKILL_DESCRIPTION, MAX_SKILL_DIRS, MAX_SKILL_ENTRIES, MAX_SKILL_FILES } from '../../src/main/plugins/skill-files'
import { MAX_SKILLS } from '../../src/shared/manifest'

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
  it.each(['open', 'session', 'overlay', 'sessions', 'notify', 'guide', 'help'])('prints the usage of %s', async (command) => {
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
    // `hook` is internal and has no USAGE line but the guide says so; keep it documented.
    expect(topic('cli')).toContain('ccc hook')
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

  it('documents the panel SDK members', () => {
    for (const member of ['ccPanel.post', 'ccPanel.onMessage', 'theme.current', 'theme.onChange']) {
      expect(topic('panels')).toContain(member)
    }
  })
})
