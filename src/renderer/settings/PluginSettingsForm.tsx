// The deep import is deliberate: the package root also exports a test helper that imports
// `@rjsf/validator-ajv8` (ajv), which this page must not bundle (see noRendererValidation).
import Form from '@rjsf/core/lib/components/Form.js'
import type { RJSFSchema, ValidatorType, WidgetProps } from '@rjsf/utils'
import { Component, createContext, useContext, useEffect, useRef, useState } from 'react'
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
      <span className={isSet ? 'settings-badge accent' : 'settings-badge'} data-secret-state={isSet ? 'set' : 'unset'}>
        {isSet ? 'Set' : 'Not set'}
      </span>
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

/** The edits worth sending: a typed value that is still empty is no change. */
function secretsToSend(edits: SecretEdits): SecretEdits {
  return Object.fromEntries(Object.entries(edits).filter(([, v]) => v === null || v !== ''))
}

/**
 * A plugin's settings form, rendered from the schema in its manifest (design §6: no plugin-owned
 * settings pages). `save` sends the values (and the secret fields' edits) to main; a rejection by
 * main's validation is listed.
 */
export function PluginSettingsForm(props: {
  schema: Record<string, unknown>
  values: Record<string, unknown>
  /** Stored values that do not validate (the plugin is disabled until they do). */
  problem?: string
  /** Whether each secret field is stored (absent when the schema has none). */
  secretFields?: SecretFieldsView
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
  const incoming = JSON.stringify([props.schema, props.values, props.problem ?? null, props.secretFields ?? null])
  const [seen, setSeen] = useState(incoming)
  if (seen !== incoming) {
    setSeen(incoming)
    setData(props.values)
    setSecretFields(props.secretFields ?? {})
    setEdits({})
    setErrors(props.problem !== undefined ? [props.problem] : [])
    setRefusals(0)
  }
  const secretState: SecretFormState = {
    fields: secretFields,
    edits,
    setEdit: (name, edit) => {
      setSaved(false)
      setEdits((prev) => {
        const next = { ...prev }
        if (edit === undefined) delete next[name]
        else next[name] = edit
        return next
      })
    }
  }

  const submit = (formData: Record<string, unknown>): void => {
    setSaving(true)
    setSaved(false)
    props.save(formData, secretsToSend(edits)).then(
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
          <Form
            schema={props.schema as RJSFSchema}
            formData={data}
            widgets={widgets}
            templates={formTemplates}
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
                  Save settings
                </button>
                {saved && (
                  <span role="status" className="settings-saved">
                    Saved.
                  </span>
                )}
              </div>
            </div>
          </Form>
        </SecretContext.Provider>
      </FormBoundary>
    </div>
  )
}
