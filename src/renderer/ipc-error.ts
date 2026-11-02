import { errorText } from '../shared/error-text'

/** A readable message for a failed `cockpit.invoke`. */
export function ipcErrorMessage(err: unknown): string {
  // ipcRenderer.invoke wraps main's error as "Error invoking remote method '<ch>': Error: <msg>".
  const text = errorText(err)
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}
