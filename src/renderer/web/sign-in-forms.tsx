// The signed-out page's sign-in forms for the password and desktop-confirm modes (design-web.md §4.2,
// plan Task 27). Their requests and answers are sign-in.ts's (DOM-free, unit-tested); this file only
// draws them and keeps the poll going. A success loads the page again: the fresh page asks the
// gateway (sign-in.ts `signIn`), finds the device cookie and goes on to the picker or the project.
import { useEffect, useState } from 'react'
import { keyedFetch, storeDeviceKey } from './device-key'
import { askConfirm, pollConfirm, shownCode, signInWithPassword } from './sign-in'

const env = {
  fetch: keyedFetch,
  userAgent: navigator.userAgent,
  // The sign-in's origin key, kept for this origin before the page loads again (device-key.ts).
  storeKey: (key: string) => storeDeviceKey(key)
}

/** The password form. A wrong password can take a while to answer (the host slows guesses). */
export function PasswordSignIn(): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="web-sign-in-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (busy || password === '') return
        setBusy(true)
        setError(null)
        void signInWithPassword(env, password).then((err) => {
          if (err === undefined) {
            location.reload()
            return
          }
          setBusy(false)
          setPassword('')
          setError(err)
        })
      }}
    >
      <label htmlFor="web-password">Password</label>
      <input
        id="web-password"
        type="password"
        autoComplete="current-password"
        // The page shows nothing else to type into: the field is what the person came for.
        autoFocus
        value={password}
        disabled={busy}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" disabled={busy || password === ''}>
        {busy ? 'Checking...' : 'Sign in'}
      </button>
      {error !== null && <p role="alert">{error}.</p>}
    </form>
  )
}

/** Where this tab keeps its waiting request's ticket: a reload goes on with it instead of asking again. */
const TICKET_KEY = 'cc-cockpit.confirm-ticket'
/** How often the page asks whether the desktop answered. */
const POLL_MS = 1500

function storedTicket(): string | undefined {
  try {
    return sessionStorage.getItem(TICKET_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function storeTicket(ticket: string | undefined): void {
  try {
    if (ticket === undefined) sessionStorage.removeItem(TICKET_KEY)
    else sessionStorage.setItem(TICKET_KEY, ticket)
  } catch {
    // No storage (a private window's settings): a reload then asks again, which is all it costs.
  }
}

type ConfirmState =
  | { state: 'idle'; note?: string }
  | { state: 'asking' }
  | { state: 'waiting'; ticket: string; code?: string; expiresAt?: number; note?: string }

/** Desktop confirm: ask, show the code, wait for the person at the desktop to type it there. */
export function ConfirmSignIn(): React.JSX.Element {
  const [state, setState] = useState<ConfirmState>(() => {
    const ticket = storedTicket()
    return ticket === undefined ? { state: 'idle' } : { state: 'waiting', ticket }
  })
  const ticket = state.state === 'waiting' ? state.ticket : undefined

  useEffect(() => {
    if (ticket === undefined) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const answer = await pollConfirm(env, ticket)
      if (!live) return
      switch (answer.state) {
        case 'allowed':
          storeTicket(undefined)
          location.reload()
          return
        case 'denied':
          storeTicket(undefined)
          setState({ state: 'idle', note: 'The desktop did not allow this browser.' })
          return
        case 'gone':
          storeTicket(undefined)
          setState({ state: 'idle', note: 'The request was not answered in time, or sign-in changed on the desktop.' })
          return
        case 'pending':
          setState({ state: 'waiting', ticket, code: answer.code, expiresAt: answer.expiresAt })
          break
        case 'error':
          // A dropped poll is retried; the code stays on screen.
          setState((s) => (s.state === 'waiting' ? { ...s, note: `Still trying: ${answer.error}.` } : s))
          break
      }
      timer = setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [ticket])

  if (state.state === 'waiting') {
    return (
      <div className="web-sign-in-form" role="status">
        <p>On the desktop, type this code into the request that appeared there:</p>
        <p className="web-confirm-shown-code" aria-label="Code">
          {state.code !== undefined ? shownCode(state.code) : '...'}
        </p>
        <p>Waiting for an answer. This page goes on by itself once it is allowed.</p>
        {state.note !== undefined && <p>{state.note}</p>}
      </div>
    )
  }
  return (
    <div className="web-sign-in-form">
      {state.state === 'idle' && state.note !== undefined && <p role="alert">{state.note}</p>}
      <button
        type="button"
        disabled={state.state === 'asking'}
        onClick={() => {
          setState({ state: 'asking' })
          void askConfirm(env).then((reply) => {
            if (!reply.ok) {
              setState({ state: 'idle', note: `Could not ask: ${reply.error}.` })
              return
            }
            storeTicket(reply.ticket.ticket)
            setState({ state: 'waiting', ticket: reply.ticket.ticket, code: reply.ticket.code, expiresAt: reply.ticket.expiresAt })
          })
        }}
      >
        {state.state === 'asking' ? 'Asking...' : 'Ask the desktop'}
      </button>
    </div>
  )
}
