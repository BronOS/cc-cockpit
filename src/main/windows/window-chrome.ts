// A project window's frame and background per platform. Pure (a type-only electron import) so vitest covers it;
// the Electron side (electron-window-factory.ts) only spreads the result into the constructor.
import type { BrowserWindowConstructorOptions } from 'electron'
import type { BlurSupport } from '../../shared/window-background'

/**
 * Height of the in-page title bar the shell draws on macOS (`.top-strip` in styles.css, where
 * `--cc-titlebar-h` mirrors it). The traffic lights are centred on it.
 */
export const TITLE_BAR_HEIGHT = 40
/** The traffic lights' diameter in macOS's own drawing (12pt), for centring them on the bar. */
const TRAFFIC_LIGHT_SIZE = 12
/**
 * Inset of the first light from the window's left edge. styles.css reserves the lights' room
 * (`--cc-traffic-lights-w`: this inset, three 12px lights with 8px gaps, and 18px before the
 * project name), so a change here moves that too.
 */
const TRAFFIC_LIGHT_X = 16

/**
 * The frame options of a project window. On macOS the page draws its own title bar (variant A of
 * the redesign: the traffic lights, the project's name and path, the cross-window strip and the
 * gear in one bar), so the native bar is hidden and the lights are inset over the page. The
 * window's `title` is still set by the factory: the Window menu, Mission Control and the Dock
 * read it even when no title bar shows it.
 *
 * Other platforms keep the native frame: Windows and Linux draw their controls on the other side
 * (or let the window manager do it), and a frameless window there would need its own minimise /
 * maximise / close buttons, which the shell does not draw. The renderer keys its layout off the
 * same platform test (navigator.platform), so the two cannot disagree on a real machine.
 */
export function projectWindowChrome(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: {
      x: TRAFFIC_LIGHT_X,
      y: Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2)
    }
  }
}

/** What main reads from `windowBackground` when it creates a project window. */
export interface ProjectWindowLook {
  transparent: boolean
  blur: boolean
}

/** An opaque window: what the picker always is, and a project window with the setting off. */
export const OPAQUE_LOOK: Readonly<ProjectWindowLook> = Object.freeze({ transparent: false, blur: false })

/**
 * macOS: the material behind a window's own content (NSVisualEffectMaterialUnderWindowBackground),
 * the one Finder's and Terminal's translucent backgrounds use. The others are for sidebars, menus
 * or HUDs and tint differently from the theme's colours.
 */
const MAC_VIBRANCY = 'under-window'

/**
 * The constructor options that make a project window see-through, or none for an opaque one.
 * Pure, like `projectWindowChrome`; the factory spreads the result over createWindow's defaults.
 *
 * - `transparent: true` with a fully transparent `backgroundColor` (createWindow's default is the
 *   theme's opaque background): the page's own backgrounds then decide what shows through. Both
 *   are creation-only in Electron, which is why the setting applies to windows opened afterwards
 *   (or reopened for it: WindowManager.reopen).
 * - Blur: macOS `vibrancy`, with `visualEffectState: 'active'` so the blur does not turn into a
 *   flat grey whenever another window has the focus (the default follows the key window, and a
 *   cockpit window spends most of its time next to an editor). Windows `backgroundMaterial:
 *   'acrylic'` (Windows 11 22H2 and later; older versions ignore it). Linux: Electron has no
 *   blur-behind, so a transparent window there shows the desktop as it is (and needs a
 *   compositing window manager to show anything but black).
 *
 * Windows caveat (Electron's own typings): `transparent` "does not work unless the window is
 * frameless", and project windows keep the native frame there (window-chrome above). The acrylic
 * material is the part expected to work on a framed window; untested, since the app has no Windows
 * build yet (README, Known limitations).
 */
export function projectWindowBackground(
  platform: NodeJS.Platform,
  look: ProjectWindowLook
): BrowserWindowConstructorOptions {
  if (!look.transparent) return {}
  const base: BrowserWindowConstructorOptions = { transparent: true, backgroundColor: '#00000000' }
  if (platform === 'darwin') {
    return { ...base, visualEffectState: 'active', ...(look.blur ? { vibrancy: MAC_VIBRANCY } : {}) }
  }
  if (platform === 'win32') return { ...base, ...(look.blur ? { backgroundMaterial: 'acrylic' } : {}) }
  return base
}

/**
 * How "Blur behind" is turned on or off on an open transparent window: both effects have a
 * setter, so unlike `transparent` the switch applies live. undefined: nothing to call (Linux).
 */
export type BlurCall =
  | { kind: 'vibrancy'; type: typeof MAC_VIBRANCY | null }
  | { kind: 'material'; material: 'acrylic' | 'none' }

export function blurCall(platform: NodeJS.Platform, on: boolean): BlurCall | undefined {
  if (platform === 'darwin') return { kind: 'vibrancy', type: on ? MAC_VIBRANCY : null }
  if (platform === 'win32') return { kind: 'material', material: on ? 'acrylic' : 'none' }
  return undefined
}

/** What the settings page says "Blur behind" does here (shared/window-background.ts BlurSupport). */
export function blurSupport(platform: NodeJS.Platform): BlurSupport {
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32') return 'acrylic'
  return 'none'
}
