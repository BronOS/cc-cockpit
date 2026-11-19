/**
 * Copy text with the selection and the editing command, inside the person's click: the app page has
 * no clipboard permission (main/windows/permissions.ts grants it none, so `navigator.clipboard.writeText`
 * is refused there), as the picker's command lines do (picker/connect-form.tsx). A browser view of the
 * web shell takes the same path. True when the copy ran.
 */
export function copyText(text: string): boolean {
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'visually-hidden'
  document.body.append(area)
  area.select()
  let ok: boolean
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  back?.focus()
  return ok
}
