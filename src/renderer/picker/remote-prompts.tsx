// The picker's prompts for a remote server (design-remote-desktop.md §3 "Prompts", §5.4): Trust this
// host?, Password, Passphrase for <key>. Main never waits on the picker: a connect, open or edit that
// needs one of these answers `{ ok: false, need }`, and `useRemotePrompts().run` shows the prompt and
// calls again with every answer of that connect so far (picker-model.ts `promptStep` / `withAnswer`:
// the accumulation and the "wrong once asks again, twice is the error" rule). Cancel ends the run and
// drops its answers; nothing of them was saved (main saves only after the dial and pairing succeed).
//
// The answers live in this run only (a local of `run`, never React state or storage): a password
// is in the page's memory for as long as the connect takes and goes with it.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteConnectAnswer } from '../../shared/ipc'
import type { RemoteAnswers, RemoteNeed } from '../../shared/remote-servers'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { newPromptFlow, promptStep, withAnswer, type PromptAnswer } from './picker-model'

/** A run's end: main's answer, the picker's own error (a secret wrong twice), or the person's Cancel. */
export type PromptedAnswer = RemoteConnectAnswer | { ok: false; cancelled: true }

export interface PromptRunOptions {
  /** Whether Remember can keep a secret here (the server row's `cookieKept`); unknown on a new connect: true. */
  canRemember?: boolean
}

interface Pending {
  need: RemoteNeed
  retry: boolean
  canRemember: boolean
  resolve(answer: PromptAnswer | null): void
}

/**
 * The prompt loop for one component (the Connect form, a server row). `run(call)` calls `call` with
 * `undefined` first and then with the accumulated answers after each prompt; `prompt` is the dialog
 * to render (null when none is up). Unmounting while a prompt is up cancels the run.
 */
export function useRemotePrompts(): {
  run(call: (answers: RemoteAnswers | undefined) => Promise<RemoteConnectAnswer>, options?: PromptRunOptions): Promise<PromptedAnswer>
  prompt: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const live = useRef<Pending | null>(null)
  useEffect(
    () => () => {
      live.current?.resolve(null)
      live.current = null
    },
    []
  )

  const run = useCallback(
    async (call: (answers: RemoteAnswers | undefined) => Promise<RemoteConnectAnswer>, options: PromptRunOptions = {}): Promise<PromptedAnswer> => {
      let flow = newPromptFlow()
      let answers: RemoteAnswers | undefined
      for (;;) {
        const answer = await call(answers)
        if (answer.ok || 'error' in answer) return answer
        const next = promptStep(flow, answer.need)
        flow = next.flow
        if ('error' in next.step) return { ok: false, error: next.step.error }
        const { ask, retry } = next.step
        const reply = await new Promise<PromptAnswer | null>((resolve) => {
          const entry: Pending = { need: ask, retry, canRemember: options.canRemember !== false, resolve }
          live.current = entry
          setPending(entry)
        })
        live.current = null
        setPending(null)
        if (reply === null) return { ok: false, cancelled: true }
        flow = withAnswer(flow, reply)
        answers = flow.answers
      }
    },
    []
  )

  let prompt: ReactNode = null
  if (pending !== null) {
    const { need } = pending
    prompt =
      need.need === 'hostKey' ? (
        <HostKeyPrompt
          key={need.sha256}
          need={need}
          onAnswer={(trust) => pending.resolve(trust ? { need: 'hostKey', sha256: need.sha256 } : null)}
        />
      ) : (
        <SecretPrompt
          // A new prompt (another try) starts empty: the wrong text is not kept in the field.
          key={`${need.need}-${pending.retry ? 'again' : 'first'}`}
          need={need}
          retry={pending.retry}
          canRemember={pending.canRemember}
          onAnswer={(answer) => pending.resolve(answer)}
        />
      )
  }
  return { run, prompt }
}

/**
 * Trust this host? (design §3, §5.3): shown on a first connect when `~/.ssh/known_hosts` does not
 * vouch for the key. An ApprovalDialog: Trust is never the default, Enter and Space do nothing inside,
 * Esc is Cancel, and Trust takes a click only after about a second of the dialog being seen, so a
 * double click on Connect cannot trust a key nobody read. Cancel has the focus (the keyboard's way in).
 */
function HostKeyPrompt(props: { need: Extract<RemoteNeed, { need: 'hostKey' }>; onAnswer(trust: boolean): void }): React.JSX.Element {
  const { need } = props
  return (
    <ApprovalDialog
      title="Trust this host?"
      allowLabel="Trust"
      denyLabel="Cancel"
      focusDeny
      testIds={{ dialog: 'remote-hostkey-prompt', allow: 'remote-hostkey-trust', deny: 'remote-hostkey-cancel' }}
      onAnswer={props.onAnswer}
    >
      <dl className="remote-hostkey">
        <dt>Host</dt>
        <dd data-testid="remote-hostkey-address">{need.address}</dd>
        <dt>Key type</dt>
        <dd data-testid="remote-hostkey-type">{need.type}</dd>
        <dt>Fingerprint</dt>
        <dd>
          <code data-testid="remote-hostkey-fingerprint">{need.sha256}</code>
        </dd>
      </dl>
      <p className="remote-prompt-hint">
        Compare with <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server.
      </p>
    </ApprovalDialog>
  )
}

/**
 * Password, or Passphrase for <key>: a masked field and Remember (on by default; off and disabled
 * where the secret store cannot keep it, when the answer lives in main's memory until the app quits).
 * A form: Enter in the field signs in, Esc cancels (kept from the Connect form's and the modal
 * picker's own Esc). Portalled over everything, like the approvals.
 */
function SecretPrompt(props: {
  need: Extract<RemoteNeed, { need: 'password' | 'passphrase' }>
  retry: boolean
  canRemember: boolean
  onAnswer(answer: PromptAnswer | null): void
}): React.JSX.Element {
  const uid = useId()
  const [secret, setSecret] = useState('')
  const [remember, setRemember] = useState(props.canRemember)
  const field = useRef<HTMLInputElement>(null)
  const answered = useRef(false)
  useEffect(() => field.current?.focus(), [])
  const { need } = props
  const answer = (value: PromptAnswer | null): void => {
    if (answered.current) return
    answered.current = true
    props.onAnswer(value)
  }
  const isPassword = need.need === 'password'
  const title = isPassword ? 'Password' : `Passphrase for ${need.path}`
  const fieldLabel = isPassword ? 'Password' : 'Passphrase'
  const titleId = `${uid}-title`
  const wrongId = `${uid}-wrong`
  return createPortal(
    <div className="confirm-backdrop confirm-over-all">
      <div
        className="confirm-dialog remote-secret"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="remote-secret-prompt"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            answer(null)
          } else if (e.key === 'Tab') {
            // The Connect form's own Tab trap must not see a Tab from here (it would pull the focus back).
            e.stopPropagation()
          }
        }}
      >
        <h2 id={titleId} className="confirm-title">
          {title}
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (secret !== '') answer({ need: need.need, secret, remember })
          }}
        >
          {props.retry && (
            <p role="alert" id={wrongId} className="remote-prompt-wrong" data-testid="remote-secret-wrong">
              {isPassword ? 'Wrong password. Try again.' : 'Wrong passphrase. Try again.'}
            </p>
          )}
          <label className="visually-hidden" htmlFor={`${uid}-field`}>
            {fieldLabel}
          </label>
          <input
            ref={field}
            id={`${uid}-field`}
            className="remote-secret-field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-testid="remote-secret-input"
            aria-describedby={props.retry ? wrongId : undefined}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <label className="confirm-check remote-secret-remember">
            <input
              type="checkbox"
              data-testid="remote-secret-remember"
              checked={remember}
              disabled={!props.canRemember}
              onChange={(e) => setRemember(e.target.checked)}
            />{' '}
            {props.canRemember ? `Remember the ${fieldLabel.toLowerCase()}` : `Remember the ${fieldLabel.toLowerCase()} (no keyring here: kept until the app quits)`}
          </label>
          <div className="confirm-buttons">
            <button type="button" data-testid="remote-secret-cancel" onClick={() => answer(null)}>
              Cancel
            </button>
            <button type="submit" data-testid="remote-secret-ok" disabled={secret === ''}>
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
