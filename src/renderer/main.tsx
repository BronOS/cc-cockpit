import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startPrefs } from './prefs/prefs-store'
import { startTheme } from './theme/apply-theme'
// The bundled terminal fonts' @font-face rules (shared/terminal-font.ts BUNDLED_TERMINAL_FONTS).
import './assets/fonts/fonts.css'
import './styles.css'

// Scopes the themed scrollbars (styles.css) away from macOS, whose overlay scrollbars already fit;
// the same platform test as the rest of the renderer (window-chrome.ts keys off the platform too).
document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'other'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element in index.html')

// Apply the theme and the shell prefs before React renders (the window's own backgroundColor covers
// the gap; a tab strip drawn first would jump its close buttons). A failure (main refused) must not
// leave a blank window: render anyway, unthemed or with the default prefs.
Promise.all([
  startTheme().catch((err: unknown) => console.warn('theme failed', err)),
  startPrefs().catch((err: unknown) => console.warn('prefs failed', err))
])
  .finally(() => {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
