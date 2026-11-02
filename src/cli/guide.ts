// `ccc guide [topic]`: the documentation a Claude session (or a person) needs to operate the app
// and write plugins, bundled into the CLI so it works with the app closed (pure CLI, no socket).
//
// The topic files are plain markdown in ./guide/, imported with Vite's `?raw` so the bundler
// inlines them into out/cli/index.js: the CLI runs from the app bundle with no source tree next to
// it, so reading the files at run time would find nothing. test/unit/cli-guide.test.ts holds drift
// guards (every `ctx` member and every USAGE command must be named) so an API change that forgets
// the docs fails the tests.
import api from './guide/api.md?raw'
import cli from './guide/cli.md?raw'
import devLoop from './guide/dev-loop.md?raw'
import overview from './guide/overview.md?raw'
import panels from './guide/panels.md?raw'
import plugins from './guide/plugins.md?raw'
import settingsSecrets from './guide/settings-secrets.md?raw'
import webview from './guide/webview.md?raw'

export interface GuideTopic {
  name: string
  summary: string
  text: string
}

/** Order is the order of the topic list. `overview` is the default and is not listed as a topic. */
export const GUIDE_TOPICS: readonly GuideTopic[] = [
  { name: 'overview', summary: 'what cc-cockpit is and how to use ccc', text: overview },
  { name: 'cli', summary: 'every ccc command', text: cli },
  { name: 'plugins', summary: 'writing a plugin: manifest, host, build', text: plugins },
  { name: 'api', summary: 'the full ctx reference for the plugin host', text: api },
  { name: 'panels', summary: 'panel pages and the ccPanel SDK', text: panels },
  { name: 'settings-secrets', summary: 'settings forms, secret fields, ctx.secrets, OAuth', text: settingsSecrets },
  { name: 'dev-loop', summary: 'linking, rebuilding and debugging a plugin', text: devLoop },
  { name: 'webview', summary: 'webview panels: showing web pages and local files', text: webview }
]

export function topicList(): string {
  const width = Math.max(...GUIDE_TOPICS.map((t) => t.name.length))
  return GUIDE_TOPICS.map((t) => `  ${t.name.padEnd(width)}  ${t.summary}`).join('\n')
}

/**
 * The text for `ccc guide [topic]`, or undefined for an unknown topic. No topic: the overview
 * followed by the topic list.
 */
export function guideText(topic?: string): string | undefined {
  if (topic === undefined) {
    const first = GUIDE_TOPICS[0] as GuideTopic
    return `${first.text.trimEnd()}\n\nTopics (ccc guide <topic>):\n${topicList()}\n`
  }
  const found = GUIDE_TOPICS.find((t) => t.name === topic)
  return found === undefined ? undefined : `${found.text.trimEnd()}\n`
}
