import { useState } from 'react'
import type { MarketplaceView, PluginView } from '../../shared/ipc'
import { serviceProblemMessage, type PluginServiceStatus, type ServiceProblem, type ServicesStatus } from '../../shared/services'
import { BlocksIcon } from './icons'
import { PluginSettingsForm } from './PluginSettingsForm'
import { Empty, Group, PageHeader, Row, Select } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

const loadPlugins = (): Promise<PluginView[]> => window.cockpit.invoke('settings.plugins')
// The notes below are a courtesy: an index that cannot be read must not break the list of installed plugins.
const loadMarketplace = (): Promise<MarketplaceView | null> => window.cockpit.invoke('settings.marketplace').catch(() => null)

// Services are this project's: main answers for the window's project and only over the plugins its host runs.
const loadServices = (): Promise<ServicesStatus | null> => window.cockpit.invoke('settings.pluginServices').catch(() => null)

/**
 * The warning a consumer's row shows for one problem. Missing and version-mismatch say what to do in
 * the page's own words; the ambiguous case (several providers, no pick) reuses the runtime's text, which
 * already points at the pick below.
 */
function problemText(problem: ServiceProblem, nameOf: (id: string) => string): string {
  switch (problem.kind) {
    case 'missing':
      return `Needs a plugin that provides ${problem.service}`
    case 'version-mismatch':
      return `Uses ${problem.service} v${problem.usesVersion}, but ${nameOf(problem.provider)} provides v${problem.providesVersion}`
    case 'ambiguous':
      return serviceProblemMessage(problem, nameOf)
  }
}

/**
 * What the Marketplace says about an installed plugin, for its row: a newer version, a safe version to
 * move a revoked one to, or why no update is offered. Only the listing from the index recorded on the
 * plugin has an `action` or a note about it (the view's rule), so other indexes add nothing here.
 */
function marketplaceNotes(view: MarketplaceView | null): Map<string, string> {
  const notes = new Map<string, string>()
  for (const e of view?.entries ?? []) {
    if (e.installedVersion === undefined || notes.has(e.id)) continue
    if (e.status === 'update') notes.set(e.id, `Version ${e.version} is available in the Marketplace.`)
    else if (e.status === 'revoked' && e.action === 'update') notes.set(e.id, `Version ${e.version} is listed in the Marketplace; move to it from there.`)
    else if (e.status === 'repo-changed' && e.note !== undefined) notes.set(e.id, e.note)
  }
  return notes
}

/**
 * Settings › Plugins: install from a git URL at a tag, link a local folder, update a git install
 * to another tag, uninstall, and edit a plugin's app-wide settings (a form rendered from its
 * manifest's schema). A plugin that is disabled shows why. main validates everything again.
 */
export function PluginsPage(props: {
  /**
   * Switch Settings to This project, where a plugin is enabled per project. Each row offers it:
   * the manual test of the bundled browser went looking for an enable switch here and found none.
   */
  onOpenProject: () => void
}): React.JSX.Element {
  const { data, error: loadError, reload: reloadPlugins } = useLoaded(loadPlugins)
  const market = useLoaded(loadMarketplace)
  const services = useLoaded(loadServices)
  const notes = marketplaceNotes(market.data)
  const reload = (): void => {
    reloadPlugins()
    market.reload()
    services.reload()
  }
  const nameOf = (id: string): string => data?.find((p) => p.id === id)?.name ?? id
  const shared = (services.data?.services ?? []).filter((s) => s.candidates.length >= 2)
  const pickProvider = (service: string, pluginId: string | null): void => {
    void run('provider', () => window.cockpit.invoke('settings.pluginServiceProvider', { service, pluginId })).then(reload)
  }
  const { busy, error, run } = useAction()
  const [url, setUrl] = useState('')
  const [tag, setTag] = useState('')

  const install = (): void => {
    void run('install', () => window.cockpit.invoke('settings.pluginInstall', { url, tag })).then((plugin) => {
      if (plugin) {
        setUrl('')
        setTag('')
      }
      reload()
    })
  }
  const link = (): void => {
    void run('link', () => window.cockpit.invoke('settings.pluginLink')).then(reload)
  }

  return (
    <section aria-label="Plugins">
      <PageHeader
        title="Plugins"
        description="Panels, commands, themes and data sources. Enable a plugin per project under This project."
      />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      <Group title="Install">
        <form
          className="settings-card"
          aria-label="Install a plugin"
          onSubmit={(e) => {
            e.preventDefault()
            install()
          }}
        >
          <div className="settings-row settings-install">
            <input
              type="text"
              className="settings-grow mono"
              aria-label="Git URL"
              placeholder="https://… or git@… or file://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
            <input
              type="text"
              className="settings-tag mono"
              aria-label="Tag"
              placeholder="tag, e.g. v1.0.0"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              spellCheck={false}
            />
            <button type="submit" className="primary" disabled={busy !== null || url.trim() === '' || tag.trim() === ''}>
              {busy === 'install' ? 'Installing…' : 'Install'}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Local folder</span>
              <div className="settings-row-help">Link a plugin you are working on; it runs from that folder.</div>
            </div>
            <div className="settings-row-control">
              <button type="button" disabled={busy !== null} onClick={link}>
                Link folder…
              </button>
            </div>
          </div>
        </form>
      </Group>
      {shared.length > 0 && (
        <Group title="Services" description="Several enabled plugins provide these in this project; calls go to the one picked.">
          <div className="settings-card" data-testid="service-picks">
            {shared.map((svc) => (
              <Row key={svc.service} label={`Plugin used for ${svc.service}`} htmlFor={`service-pick-${svc.service}`}>
                <Select
                  id={`service-pick-${svc.service}`}
                  wide
                  disabled={busy !== null}
                  value={svc.selected ?? ''}
                  onChange={(e) => pickProvider(svc.service, e.target.value === '' ? null : e.target.value)}
                >
                  {svc.selected === null && <option value="">Pick one</option>}
                  {svc.candidates.map((id) => (
                    <option key={id} value={id}>
                      {nameOf(id)}
                    </option>
                  ))}
                </Select>
              </Row>
            ))}
          </div>
        </Group>
      )}
      <Group title="Installed">
        {data === null ? null : data.length === 0 ? (
          <div className="settings-card">
            <Empty>No plugins installed.</Empty>
          </div>
        ) : (
          <ul className="settings-card settings-list">
            {data.map((plugin) => (
              <PluginItem
                key={plugin.id}
                plugin={plugin}
                busy={busy}
                note={notes.get(plugin.id)}
                services={services.data?.plugins.find((p) => p.id === plugin.id)}
                nameOf={nameOf}
                run={run}
                reload={reload}
                onOpenProject={props.onOpenProject}
              />
            ))}
          </ul>
        )}
      </Group>
    </section>
  )
}

function PluginItem(props: {
  plugin: PluginView
  busy: string | null
  /** What the Marketplace says about this plugin (a newer version, why none is offered). */
  note: string | undefined
  /** What the plugin provides and uses here; absent when it is not enabled in this project or has no host. */
  services: PluginServiceStatus | undefined
  nameOf: (id: string) => string
  run: ReturnType<typeof useAction>['run']
  reload: () => void
  onOpenProject: () => void
}): React.JSX.Element {
  const { plugin, busy, run, reload } = props
  const [updateTag, setUpdateTag] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  return (
    <li className="settings-item column" data-plugin={plugin.id}>
      <div className="settings-item-head">
        <BlocksIcon className="settings-item-glyph" />
        <div className="settings-item-main">
          <div className="settings-item-title">
            {plugin.name}
            {!plugin.state.ok && (
              <span className="settings-badge warn">{plugin.state.revoked ? 'revoked' : 'disabled'}</span>
            )}
          </div>
          <div className="settings-item-meta">
            <span className="mono">{plugin.id}</span> · {plugin.version}
          </div>
          <div className="settings-item-meta">
            {plugin.source.kind === 'git'
              ? `git ${plugin.source.url} @ ${plugin.source.tag}`
              : plugin.source.kind === 'linked'
                ? `linked ${plugin.source.path}`
                : 'built in'}
          </div>
          {!plugin.state.ok && <div role="alert" className="settings-error">{plugin.state.reason}</div>}
          {props.note !== undefined && <div className="settings-item-meta" data-testid="marketplace-note">{props.note}</div>}
          {props.services !== undefined && props.services.provides.length > 0 && (
            <div className="settings-item-meta" data-testid="service-provides">
              Provides: {props.services.provides.map((e) => `${e.service} v${e.version}`).join(', ')}
            </div>
          )}
          {props.services !== undefined && props.services.uses.length > 0 && (
            <div className="settings-item-meta" data-testid="service-uses">
              Uses: {props.services.uses.map((e) => `${e.service} v${e.version}`).join(', ')}
            </div>
          )}
          {props.services?.problems.map((problem, i) => (
            <div key={i} className="settings-warning" data-testid="service-warning">
              {problemText(problem, props.nameOf)}
            </div>
          ))}
          {plugin.appSettings?.problem !== undefined && (
            <div className="settings-error">Stored settings are invalid; the plugin stays disabled until they are fixed.</div>
          )}
        </div>
        <div className="settings-item-actions">
          {confirming ? (
            <>
              <span className="settings-confirm">Uninstall?</span>
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() => {
                  setConfirming(false)
                  void run('uninstall', () => window.cockpit.invoke('settings.pluginUninstall', { id: plugin.id })).then(
                    reload
                  )
                }}
              >
                Yes, uninstall
              </button>
              <button type="button" className="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="quiet" onClick={props.onOpenProject}>
                Enable in This project
              </button>
              {plugin.appSettings && (
                <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
                  Settings
                </button>
              )}
              {plugin.source.kind !== 'bundled' && (
                <button type="button" className="quiet" disabled={busy !== null} onClick={() => setConfirming(true)}>
                  Uninstall
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {plugin.source.kind === 'git' && (
        <form
          className="settings-item-foot"
          aria-label={`Update ${plugin.id}`}
          onSubmit={(e) => {
            e.preventDefault()
            void run('update', () => window.cockpit.invoke('settings.pluginUpdate', { id: plugin.id, tag: updateTag })).then(
              (updated) => {
                if (updated) setUpdateTag('')
                reload()
              }
            )
          }}
        >
          <span className="settings-item-meta">Update to</span>
          <input
            type="text"
            className="settings-tag mono"
            aria-label={`New tag for ${plugin.id}`}
            placeholder="newer tag"
            value={updateTag}
            onChange={(e) => setUpdateTag(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" disabled={busy !== null || updateTag.trim() === ''}>
            Update
          </button>
        </form>
      )}
      {plugin.appSettings && showSettings && (
        <PluginSettingsForm
          schema={plugin.appSettings.schema}
          values={plugin.appSettings.values}
          {...(plugin.appSettings.problem !== undefined ? { problem: plugin.appSettings.problem } : {})}
          {...(plugin.appSettings.secretFields !== undefined ? { secretFields: plugin.appSettings.secretFields } : {})}
          save={(values, secrets) => window.cockpit.invoke('settings.pluginSettingsSave', { id: plugin.id, values, secrets })}
          onSaved={reload}
        />
      )}
    </li>
  )
}
