import { useState } from 'react'
import { MAX_DISCUSS_PROMPT } from '../../shared/discuss'

/** What the empty field suggests; the setting itself stays empty (nothing is added) until the person types. */
export const DISCUSS_PROMPT_PLACEHOLDER =
  "Sent from cc-cockpit's Discuss: I want to talk this through with you. Answer first; don't change files until I ask."

/**
 * The Discuss prompt textarea (Settings › General and This Project): a draft that saves when the
 * field loses focus, so typing is not a save per keystroke and a refusal (main checks the cap
 * again) leaves the person's text in place with the error shown by the page. The draft follows
 * `value` when main's copy changes (another window, "Use the global prompt").
 */
export function DiscussPromptField(props: {
  id: string
  label: string
  value: string
  disabled: boolean
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(props.value)
  // Follow main's copy when it changes: state adjusted while rendering, not in an effect.
  const [seen, setSeen] = useState(props.value)
  if (seen !== props.value) {
    setSeen(props.value)
    setDraft(props.value)
  }
  return (
    <textarea
      id={props.id}
      aria-label={props.label}
      rows={4}
      value={draft}
      maxLength={MAX_DISCUSS_PROMPT}
      placeholder={DISCUSS_PROMPT_PLACEHOLDER}
      disabled={props.disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== props.value) props.onCommit(draft)
      }}
    />
  )
}
