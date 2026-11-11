// Applies main's current theme: the CSS variables on :root, and the xterm palette for every
// terminal (current and future). main decides which theme is current (a user pick, else the OS
// appearance) and pushes changes, so the page never picks a theme itself. The web shell only reports
// its browser's prefers-color-scheme for main to resolve by (web/main.tsx, design-web.md §5.7).
import { applyTheme } from './theme-store'

/** Fetch and apply the current theme, then follow changes. Call once per page load. */
export async function startTheme(): Promise<void> {
  // Subscribed first: a change between the two cannot be lost, only applied twice.
  window.cockpit.on('theme.changed', (theme) => applyTheme(theme, document.documentElement))
  applyTheme(await window.cockpit.invoke('theme.get'), document.documentElement)
}
