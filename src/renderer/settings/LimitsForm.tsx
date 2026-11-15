// The caps form (design-rooms.md §6), shared by a plugin's "Limits" on Settings › Plugins and the global "Plugin limits"
// on Settings › General: one field per cap, where its value comes from, a reset per row and Save. Main checks every
// value again (plugins.limits.set / plugins.globalLimits.set); the draft logic is plugin-list-model.ts.
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { PluginLimitView } from '../../shared/plugin-limits'
import { isServerView, isWebShell } from '../shell-kind'
import { limitsDraft, limitsDraftAfterReset, limitsEdit, limitsEditable, limitSourceText, type LimitsDraft, type LimitsViewLike } from './plugin-list-model'
import { Row } from './ui'
import type { Action } from './use-action'

export interface LimitsSave {
  set?: Array<[string, number]>
  reset?: string[]
}

/**
 * `level` decides the words: a plugin's form inherits from the global values ("Use global"), the global form from the
 * built-in defaults ("Use default"). `card` draws it as a settings card (Settings › General) instead of a row's
 * sub-panel (Settings › Plugins).
 */
export function LimitsForm<V extends LimitsViewLike>(props: {
  level: 'plugin' | 'global'
  /** Read when shown and whenever it changes (a stable function: module-level or useCallback). */
  load: () => Promise<V>
  save: (payload: LimitsSave) => Promise<V>
  /** What `run` is told (the page's busy label). */
  runLabel: string
  busy: string | null
  run: Action['run']
  ariaLabel: string
  testId: string
  intro?: ReactNode
  card?: boolean
}): React.JSX.Element {
  const { level, load, busy, run } = props
  const [view, setView] = useState<V | null>(null)
  const [draft, setDraft] = useState<LimitsDraft>({})
  const [failed, setFailed] = useState(false)
  const baseId = useId()
  // A browser view of a desktop cockpit is refused the save (main decides; this only spares it the dead end).
  const editable = limitsEditable(isWebShell(), isServerView())
  const apply = (v: V): void => {
    setView(v)
    setDraft(limitsDraft(v))
  }
  useEffect(() => {
    let live = true
    load().then(
      (v) => {
        if (!live) return
        setView(v)
        setDraft(limitsDraft(v))
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [load])
  if (failed) return <p className="settings-error">The limits could not be read.</p>
  if (view === null) return <p className="settings-item-meta">Loading limits…</p>
  const { edit, problems } = limitsEdit(view, draft)
  const save = (payload: LimitsSave): void => {
    void run(props.runLabel, () => props.save(payload)).then((v) => {
      if (!v) return
      // A reset-only save (the reset of one row) keeps what was typed in the other fields.
      if (payload.set === undefined || payload.set.length === 0) {
        setView(v)
        setDraft((d) => limitsDraftAfterReset(v, d, payload.reset ?? []))
      } else apply(v)
    })
  }
  const resetLabel = level === 'plugin' ? 'Use global' : 'Use default'
  const canSave = editable && edit !== null && Object.keys(problems).length === 0
  const rows = view.limits.map((l: PluginLimitView) => {
    const inputId = `${baseId}-${l.key}`
    const problem = problems[l.key]
    return (
      <div className="settings-row" key={l.key} data-testid={`limit-${l.key}`}>
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor={inputId}>
            {l.label}
          </label>
          <div className="settings-row-help">
            <span className="mono">{l.key}</span> · <span data-testid="limit-source">{limitSourceText(l, level)}</span> · default {l.default}, at most{' '}
            {l.ceiling}
          </div>
          {problem !== undefined && (
            <div role="alert" className="settings-error">
              {problem}
            </div>
          )}
        </div>
        <div className="settings-row-control">
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            className="settings-tag mono"
            value={draft[l.key] ?? ''}
            readOnly={!editable}
            aria-invalid={problem !== undefined}
            onChange={(ev) => setDraft((d) => ({ ...d, [l.key]: ev.target.value }))}
            spellCheck={false}
          />
          {editable && l.overridden && (
            <button type="button" className="quiet" disabled={busy !== null} onClick={() => save({ reset: [l.key] })}>
              {resetLabel}
            </button>
          )}
        </div>
      </div>
    )
  })
  const readOnly = !editable && (
    <p className={props.card ? 'settings-row-help settings-note' : 'settings-item-meta'} data-testid="plugin-limits-readonly">
      Read-only here: change these in the cc-cockpit app on the computer it runs on, or with <span className="mono">ccc plugin limits</span> in a
      shell there.
    </p>
  )
  const submit = (
    <button type="submit" className="primary" disabled={busy !== null || !canSave}>
      Save limits
    </button>
  )
  return (
    <form
      className={props.card ? 'settings-card' : 'settings-subpanel'}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      onSubmit={(ev) => {
        ev.preventDefault()
        if (canSave && edit !== null) save(edit)
      }}
    >
      {props.intro !== undefined && <p className="settings-item-meta">{props.intro}</p>}
      {readOnly}
      {rows}
      {editable &&
        (props.card ? (
          <Row className="settings-form-foot" label="">
            {submit}
          </Row>
        ) : (
          <div className="settings-row-control">{submit}</div>
        ))}
    </form>
  )
}
