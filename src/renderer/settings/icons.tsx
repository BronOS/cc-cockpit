// Stroke glyphs for the settings screen, in the picker's vocabulary (picker/icons.tsx): 16px on a
// 16-unit grid, 1.25 strokes, round joins, currentColor so a rule picks the colour (subtle at rest,
// accent on the active section). Decorative only: every one is aria-hidden and has no <title>, so
// it adds nothing to a button's accessible name or text (the nav's buttons are matched by text).

type GlyphProps = { size?: number; className?: string }

function Glyph(props: GlyphProps & { children: React.ReactNode }): React.JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      className={props.className ?? 'settings-glyph'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

/** Projects: the picker's folder. */
export function FolderIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44L8.3 4.5h4.2A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Glyph>
  )
}

/** Plugins: four blocks, one of them lifted out (an add-on). */
export function BlocksIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1" transform="rotate(12 11.5 4.5)" />
    </Glyph>
  )
}

/** Marketplace: a shop awning over a counter. */
export function StoreIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M2.5 6.5V13h11V6.5" />
      <path d="M2 3h12l1 3.2a1.8 1.8 0 0 1-3.3.9 1.8 1.8 0 0 1-3.4 0 1.8 1.8 0 0 1-3.4 0A1.8 1.8 0 0 1 1 6.2z" />
    </Glyph>
  )
}

/** This Project: three sliders. */
export function SlidersIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M2.5 4.5h6M11.5 4.5h2M2.5 8h2M7.5 8h6M2.5 11.5h7M12.5 11.5h1" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="6" cy="8" r="1.5" />
      <circle cx="11" cy="11.5" r="1.5" />
    </Glyph>
  )
}

/** General: a gear (a ring with eight teeth around a hub). */
export function GearIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" />
      <circle cx="8" cy="8" r="4.25" />
    </Glyph>
  )
}

/** Keybindings: a keyboard. */
export function KeyboardIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <rect x="1.75" y="4" width="12.5" height="8" rx="1.5" />
      <path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.5 9.5h5" />
    </Glyph>
  )
}

/** Appearance: a half-filled disc (light and dark). */
export function ContrastIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

/** A panel in a window (the panel zones). */
export function PanelIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </Glyph>
  )
}

export function CloseIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.5" />
    </Glyph>
  )
}

/** The chevron drawn over a native <select> (settings-select). */
export function ChevronDownIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M4.5 6.25 8 9.75l3.5-3.5" strokeWidth="1.5" />
    </Glyph>
  )
}

export function ArrowUpIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
    </Glyph>
  )
}

export function ArrowDownIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
    </Glyph>
  )
}

/** Add an entry (a plugin settings form's array). */
export function PlusIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M8 3.5v9M3.5 8h9" strokeWidth="1.5" />
    </Glyph>
  )
}

export function TrashIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25M4 4.25l.6 8.4a1 1 0 0 0 1 .85h4.8a1 1 0 0 0 1-.85l.6-8.4" />
    </Glyph>
  )
}

/** The magnifier of a filter field, as in the picker's search. */
export function SearchIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <circle cx="7" cy="7" r="4.75" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" strokeWidth="1.5" />
    </Glyph>
  )
}
