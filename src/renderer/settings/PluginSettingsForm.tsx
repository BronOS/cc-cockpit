// The deep import is deliberate: the package root also exports a test helper that imports
// `@rjsf/validator-ajv8` (ajv), which this page must not bundle (see noRendererValidation).
import Form from '@rjsf/core/lib/components/Form.js'
import DefaultObjectFieldTemplate from '@rjsf/core/lib/components/templates/ObjectFieldTemplate.js'
import type { ObjectFieldTemplateProps, RJSFSchema, UiSchema, ValidatorType, WidgetProps } from '@rjsf/utils'
import { Component, createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { errorText } from '../../shared/error-text'
import type { PluginSettingsSaveResult, SecretEdits, SecretFieldsView } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { formatWidgets, formTemplates } from './plugin-form-templates'

/**
 * rjsf's usual validator is ajv, which compiles a schema into a function with `new Function`:
 * that needs 'unsafe-eval' in the page's CSP, and this page's CSP (index.html) stays strict. So
 * the form gets a validator that checks nothing and the schema never reaches an ajv in the
 * renderer. main is the authority: it re-validates every save against the manifest's schema (no
 * regexes, no custom keywords, defaults applied: plugins/validate.ts) and answers with the
 * reasons, shown by the Save button.
 *
 * What a validator also does for rjsf is pick the matching branch of `oneOf`/`anyOf` and of
 * `if/then/else`: with `isValid` always true the first branch is the one shown. Settings schemas
 * are flat objects of strings, numbers, booleans and enums, which do not need more.
 *
 * rjsf fills every array up to its `minItems` with default entries (its default populate mode,
 * kept). That is safe only because main refuses a schema whose filled-in defaults could grow past
 * a budget (validate.ts MAX_SCHEMA_EXPANSION, which over-approximates this population).
 */
export const noRendererValidation: ValidatorType = {
  validateFormData: () => ({ errors: [], errorSchema: {} }),
  isValid: () => true,
  rawValidation: () => ({ errors: [] })
}

/** The schema is a plugin's: a crash in the form (a `$ref` it cannot resolve) must not take the page down. */
class FormBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  override state = { error: null as string | null }

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: errorText(err) }
  }

  override render(): React.ReactNode {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <p role="alert" className="settings-alert">
        This settings form cannot be shown: {this.state.error}
      </p>
    )
  }
}

/**
 * What the secret widgets of one form share: whether each field is stored (main's answer, never
 * the value) and the edits waiting for Save. A React context rather than rjsf's `formContext`:
 * rjsf skips re-rendering a field whose props compare equal, and context reaches it regardless.
 */
interface SecretFormState {
  fields: SecretFieldsView
  /** By field: the new value being typed (a string), a clear (null). Absent: unchanged. */
  edits: SecretEdits
  setEdit(name: string, edit: string | null | undefined): void
}
const SecretContext = createContext<SecretFormState>({ fields: {}, edits: {}, setEdit: () => {} })

/**
 * The widget rjsf picks for a string field with `"format": "secret"` (a format with a registered
 * widget of the same name). The form never holds the stored value: main sends only whether one is
 * set. It shows "Set" / "Not set" with Replace (a password field; the value goes to main once, on
 * Save) and Clear. rjsf's own value for the field stays empty: the edits travel beside the form
 * data, in the save's `secrets`, so a secret is never part of `values`.
 */
function SecretWidget(props: WidgetProps): React.JSX.Element {
  const ctx = useContext(SecretContext)
  const name = props.name
  const isSet = ctx.fields[name]?.set === true
  // A value stored by the other mode's store (or under a replaced key file) is there but cannot be
  // read here: the field says so and Replace takes the value again (design-web.md §9.5).
  const unreadable = ctx.fields[name]?.unreadable
  const edit = Object.hasOwn(ctx.edits, name) ? ctx.edits[name] : undefined
  const disabled = props.disabled === true || props.readonly === true
  const label = typeof props.label === 'string' && props.label !== '' ? props.label : name
  if (typeof edit === 'string') {
    return (
      <div className="settings-secret">
        <input
          id={props.id}
          type="password"
          className="form-control"
          // A password manager must not fill in or offer to save a plugin's token as a site login.
          autoComplete="new-password"
          spellCheck={false}
          placeholder={isSet ? 'New value' : 'Value'}
          value={edit}
          disabled={disabled}
          autoFocus
          onChange={(e) => ctx.setEdit(name, e.target.value)}
        />
        <button type="button" className="quiet" disabled={disabled} onClick={() => ctx.setEdit(name, undefined)}>
          Cancel
        </button>
      </div>
    )
  }
  // Clearing: the field is marked to be cleared on Save, with a way back.
  if (edit === null) {
    return (
      <div className="settings-secret">
        <span className="settings-badge warn" data-secret-state="clearing">
          Cleared on save
        </span>
        <button type="button" className="quiet" disabled={disabled} onClick={() => ctx.setEdit(name, undefined)}>
          Undo
        </button>
      </div>
    )
  }
  return (
    <div className="settings-secret">
      {unreadable !== undefined ? (
        <span className="settings-badge warn" data-secret-state={unreadable}>
          {unreadable === 'other-mode' ? 'Stored in the other mode: enter it again' : 'Key file replaced: enter it again'}
        </span>
      ) : (
        <span className={isSet ? 'settings-badge accent' : 'settings-badge'} data-secret-state={isSet ? 'set' : 'unset'}>
          {isSet ? 'Set' : 'Not set'}
        </span>
      )}
      <button
        type="button"
        aria-label={`${isSet ? 'Replace' : 'Add'} ${label}`}
        disabled={disabled}
        onClick={() => ctx.setEdit(name, '')}
      >
        {isSet ? 'Replace' : 'Add'}
      </button>
      {isSet && (
        <button
          type="button"
          className="quiet"
          aria-label={`Clear ${label}`}
          disabled={disabled}
          onClick={() => ctx.setEdit(name, null)}
        >
          Clear
        </button>
      )}
    </div>
  )
}

const widgets = { ...formatWidgets, secret: SecretWidget }

/**
 * A project form's "Use global" switches (design-next §5.2): which top-level fields this project
 * overrides now (edited, not saved yet), and the switch of one field. Absent (null) on the app-wide
 * and global forms, which have no such choice. A context like SecretContext: rjsf builds the root's
 * property elements before the template sees them, and the switches must follow a toggle.
 */
interface OverrideFormState {
  overridden: ReadonlySet<string>
  setOverride(name: string, override: boolean): void
  disabled: boolean
}
const OverrideContext = createContext<OverrideFormState | null>(null)

/** The top-level properties of a schema, by name (main checked the schema; a manifest's, so anything). */
function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties
  return typeof props === 'object' && props !== null && !Array.isArray(props) ? (props as Record<string, unknown>) : {}
}

/** The label of a top-level field: its schema title, else its name. */
function fieldTitle(schema: Record<string, unknown>, name: string): string {
  const field = propertiesOf(schema)[name]
  const title = typeof field === 'object' && field !== null ? (field as { title?: unknown }).title : undefined
  return typeof title === 'string' && title.trim() !== '' ? title : name
}

/** The top-level properties with `"format": "secret"` (main allows the format only there). */
function secretFieldNames(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Object.entries(propertiesOf(schema))
      .filter(([, v]) => typeof v === 'object' && v !== null && (v as { format?: unknown }).format === 'secret')
      .map(([k]) => k)
  )
}

/**
 * One top-level field of a project form, under its "Use global" switch. Using the global value, the
 * field shows that value and is disabled (uiSchema `ui:disabled`, which rjsf passes down to every
 * input of a nested object or array); switched off, the field is this project's override, edited
 * in place.
 */
function OverrideField(props: { name: string; title: string; children: React.ReactNode }): React.JSX.Element {
  const ctx = useContext(OverrideContext)
  const id = useId()
  const overridden = ctx?.overridden.has(props.name) === true
  return (
    <div className="settings-override" data-override-field={props.name} data-override={overridden ? 'on' : 'off'}>
      <label className="settings-override-toggle" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={!overridden}
          disabled={ctx?.disabled !== false}
          // Named "Use global" alone, the field's title left out: a name that held it would also
          // answer a lookup of the field by its label (getByLabel matches a part of a name).
          title={`Use the global value of ${props.title}`}
          onChange={(e) => ctx?.setOverride(props.name, !e.target.checked)}
        />
        Use global
      </label>
      {props.children}
    </div>
  )
}

/** rjsf's object template, with each top-level field of a project form under its switch. */
function ObjectFieldTemplate(props: ObjectFieldTemplateProps): React.JSX.Element | null {
  const ctx = useContext(OverrideContext)
  if (ctx === null || props.fieldPathId.$id !== 'root') return <DefaultObjectFieldTemplate {...props} />
  const schema = props.schema as Record<string, unknown>
  const properties = props.properties.map((p) =>
    p.hidden
      ? p
      : {
          ...p,
          content: (
            <OverrideField key={p.name} name={p.name} title={fieldTitle(schema, p.name)}>
              {p.content}
            </OverrideField>
          )
        }
  )
  return <DefaultObjectFieldTemplate {...props} properties={properties} />
}

const templates = { ...formTemplates, ObjectFieldTemplate }

/**
 * A project form's project mode (design-next §5.2): which fields the project overrides as stored,
 * and the global values a field shows on "Use global".
 */
export interface ProjectOverrides {
  /** The fields this project overrides as stored (PluginAppSettingsView.overrides). */
  fields: string[]
  /** The global values, defaults applied (PluginAppSettingsView.globalValues). */
  globalValues: Record<string, unknown>
  /** Whether each secret field has a global value (PluginAppSettingsView.globalSecretFields). */
  globalSecretFields?: SecretFieldsView
}

/** The edits worth sending: a typed value that is still empty is no change. */
function secretsToSend(edits: SecretEdits): SecretEdits {
  return Object.fromEntries(Object.entries(edits).filter(([, v]) => v === null || v !== ''))
}

/**
 * A plugin's settings form, rendered from the schema in its manifest (design §6; a plugin's html
 * page, if any, is drawn under it). `save` sends the values (and the secret fields' edits) to main;
 * a rejection by main's validation is listed.
 *
 * With `overrides` it is a project's form (This Project): each top-level field has "Use global"
 * (the default) or is overridden, and a save sends only the overridden fields, so a field the user
 * never touched keeps following the global value. "Use global" on a field that was overridden
 * drops the override (a secret one is cleared). Without it, every field is sent, as before.
 */
export function PluginSettingsForm(props: {
  schema: Record<string, unknown>
  values: Record<string, unknown>
  /** Stored values that do not validate (the plugin is disabled until they do). */
  problem?: string
  /** Whether each secret field is stored (absent when the schema has none). */
  secretFields?: SecretFieldsView
  /** A project's form: what it overrides and the global values (see above). */
  overrides?: ProjectOverrides
  /** The Save button's text (default "Save settings"); a page with two forms names them apart. */
  saveLabel?: string
  save: (values: Record<string, unknown>, secrets: SecretEdits) => Promise<PluginSettingsSaveResult>
  onSaved: () => void
}): React.JSX.Element {
  const [errors, setErrors] = useState<string[]>(props.problem !== undefined ? [props.problem] : [])
  // Where the list stands: at the top for the stored values' problem, met when the form opens; by
  // Save for a save's refusal. A long form (an array of rules) put the top list out of view, so a
  // refused Save looked like it did nothing. Counted, so a second refusal with the same reasons
  // still brings the list into view.
  const [refusals, setRefusals] = useState(0)
  const errorsRef = useRef<HTMLUListElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (refusals === 0) return
    // The list and the Save button under it, both in view when they fit.
    footerRef.current?.scrollIntoView({ block: 'nearest' })
    errorsRef.current?.focus({ preventScroll: true })
  }, [refusals])
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  // The form owns the values while it is edited. A reload that brings a different schema, stored
  // values, secret states or problem (a dev reload of a linked plugin, a save from another window)
  // starts it over from them, else it would show and save stale values against a changed schema.
  // Compared by content: the list reloads for unrelated reasons, and those must not wipe what is
  // being typed. Not a remount (key): after our own save the reload brings the saved values, and
  // "Saved." stays.
  const [data, setData] = useState<Record<string, unknown>>(props.values)
  const [secretFields, setSecretFields] = useState<SecretFieldsView>(props.secretFields ?? {})
  const [edits, setEdits] = useState<SecretEdits>({})
  const [overridden, setOverridden] = useState<ReadonlySet<string>>(() => new Set(props.overrides?.fields ?? []))
  const incoming = JSON.stringify([props.schema, props.values, props.problem ?? null, props.secretFields ?? null, props.overrides ?? null])
  const [seen, setSeen] = useState(incoming)
  if (seen !== incoming) {
    setSeen(incoming)
    setData(props.values)
    setSecretFields(props.secretFields ?? {})
    setEdits({})
    setOverridden(new Set(props.overrides?.fields ?? []))
    setErrors(props.problem !== undefined ? [props.problem] : [])
    setRefusals(0)
  }
  const project = props.overrides
  const secretNames = secretFieldNames(props.schema)
  const setEdit = (name: string, edit: string | null | undefined): void => {
    setSaved(false)
    setEdits((prev) => {
      const next = { ...prev }
      if (edit === undefined) delete next[name]
      else next[name] = edit
      return next
    })
  }
  const secretState: SecretFormState = {
    // A project's secret field shows the global value's state while it uses global, and its own
    // (an override stored or not) once overridden: the view's `secretFields` are the effective
    // ones, which would call a fresh override "Set" when only the global value is.
    fields:
      project === undefined
        ? secretFields
        : Object.fromEntries(
            [...secretNames].map((f) => [
              f,
              // The view's own entry carries why a stored value cannot be read, so it is passed on whole.
              overridden.has(f)
                ? project.fields.includes(f)
                  ? (secretFields[f] ?? { set: true })
                  : { set: false }
                : (project.globalSecretFields?.[f] ?? { set: false })
            ])
          ),
    edits,
    setEdit
  }
  const overrideState: OverrideFormState | null =
    project === undefined
      ? null
      : {
          overridden,
          disabled: saving,
          setOverride: (name, override) => {
            setSaved(false)
            setOverridden((prev) => {
              const next = new Set(prev)
              if (override) next.add(name)
              else next.delete(name)
              return next
            })
            if (override) return
            // Back to the global value: the field shows it again, and a typed secret is dropped.
            if (secretNames.has(name)) {
              setEdit(name, undefined)
              return
            }
            setData((prev) => {
              const next = { ...prev }
              if (Object.hasOwn(project.globalValues, name)) next[name] = structuredClone(project.globalValues[name])
              else delete next[name]
              return next
            })
          }
        }
  // A project form's fields on "Use global" are shown disabled; rjsf passes it down to nested inputs.
  const uiSchema: UiSchema | undefined =
    project === undefined
      ? undefined
      : Object.fromEntries(
          Object.keys(propertiesOf(props.schema))
            .filter((f) => !overridden.has(f))
            .map((f) => [f, { 'ui:disabled': true }])
        )

  /** What a save sends: every field, or for a project its overrides only ("Use global" clears one). */
  const toSend = (formData: Record<string, unknown>): { values: Record<string, unknown>; secrets: SecretEdits } => {
    if (project === undefined) return { values: formData, secrets: secretsToSend(edits) }
    // Known limits: an overridden optional field the user emptied (rjsf drops the key) is not sent, so it
    // becomes "Use global" after the save; and a stored override of a key the schema no longer declares is
    // dropped by the first save (the save replaces the overrides). Neither touches a secret.
    const values = Object.fromEntries(Object.entries(formData).filter(([k]) => overridden.has(k) && !secretNames.has(k)))
    const secrets: SecretEdits = {}
    for (const [name, edit] of Object.entries(secretsToSend(edits))) if (overridden.has(name)) secrets[name] = edit
    // A secret override switched back to "Use global": its own value goes.
    for (const name of project.fields) if (secretNames.has(name) && !overridden.has(name)) secrets[name] = null
    return { values, secrets }
  }

  const submit = (formData: Record<string, unknown>): void => {
    setSaving(true)
    setSaved(false)
    const out = toSend(formData)
    props.save(out.values, out.secrets).then(
      (result) => {
        setSaving(false)
        if (result.ok) {
          setErrors([])
          setData(result.values)
          // The typed values leave the page once main has them.
          setEdits({})
          if (result.secretFields !== undefined) setSecretFields(result.secretFields)
          setSaved(true)
          props.onSaved()
        } else {
          setErrors(result.errors)
          setRefusals((n) => n + 1)
        }
      },
      (err: unknown) => {
        setSaving(false)
        setErrors([ipcErrorMessage(err)])
        setRefusals((n) => n + 1)
      }
    )
  }

  // One list, never two: at the top or by Save (see `refusals`). Focusable so a refusal can move
  // the keyboard there (tabIndex -1: not a stop in the Tab order).
  const errorList =
    errors.length > 0 ? (
      <ul role="alert" ref={errorsRef} tabIndex={-1} className="settings-alert settings-form-errors">
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    ) : null

  return (
    // A panel under the plugin's row; rjsf's markup (and the templates in plugin-form-templates)
    // is drawn as label / field rows by the `.settings-plugin-form` rules.
    <div className="settings-subpanel settings-plugin-form">
      {refusals === 0 && errorList}
      <FormBoundary>
        <SecretContext.Provider value={secretState}>
          <OverrideContext.Provider value={overrideState}>
            <Form
              schema={props.schema as RJSFSchema}
              formData={data}
              {...(uiSchema !== undefined ? { uiSchema } : {})}
              widgets={widgets}
              templates={templates}
              validator={noRendererValidation}
              noValidate
              // The browser's own constraint check (min/max/required on the inputs) would block the
              // submit with a native bubble; main's answer is the one the user should see.
              noHtml5Validate
              liveValidate={false}
              disabled={saving}
              onChange={(e) => {
                setSaved(false)
                setData((e.formData ?? {}) as Record<string, unknown>)
              }}
              onSubmit={(e) => submit((e.formData ?? {}) as Record<string, unknown>)}
            >
              <div ref={footerRef}>
                {refusals > 0 && errorList}
                <div className="settings-form-actions">
                  <button type="submit" className="primary" disabled={saving}>
                    {props.saveLabel ?? 'Save settings'}
                  </button>
                  {saved && (
                    <span role="status" className="settings-saved">
                      Saved.
                    </span>
                  )}
                </div>
              </div>
            </Form>
          </OverrideContext.Provider>
        </SecretContext.Provider>
      </FormBoundary>
    </div>
  )
}
