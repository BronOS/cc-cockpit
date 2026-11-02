// Stroke glyphs for the project window (title bar, tabs, panel headers, web view toolbar), in the
// vocabulary of the picker and the settings screen (settings/icons.tsx): a 16-unit grid, 1.25
// strokes, round joins, currentColor so a rule picks the colour. Decorative only: each is
// aria-hidden with no <title>, so it adds nothing to the accessible name of the button it sits in
// (the buttons are named by aria-label, and the e2e specs find them by those names).

type GlyphProps = { size?: number; className?: string }

function Glyph(props: GlyphProps & { children: React.ReactNode; viewBox?: string }): React.JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      className={props.className ? `glyph ${props.className}` : 'glyph'}
      width={size}
      height={size}
      viewBox={props.viewBox ?? '0 0 16 16'}
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

/** The project folder, before the project's name in the title bar (the picker's folder). */
export function FolderGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44L8.3 4.5h4.2A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Glyph>
  )
}

export function PlusGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M8 3.25v9.5M3.25 8h9.5" strokeWidth="1.5" />
    </Glyph>
  )
}

export function CloseGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeWidth="1.4" />
    </Glyph>
  )
}

/** Three dots: a panel header's zone menu (move / hide). */
export function MoreGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <circle cx="3.75" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.25" cy="8" r="0.6" fill="currentColor" />
    </Glyph>
  )
}

/** The core Sessions panel's icon: two session cards, each with its status dot and a line. */
export function SessionsGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="4.5" rx="1.25" />
      <rect x="2.25" y="8.75" width="11.5" height="4.5" rx="1.25" />
      <path d="M4.75 5h.01M4.75 11h.01" strokeWidth="2" />
      <path d="M7 5h4.25M7 11h3" />
    </Glyph>
  )
}

/** A shell tab: a prompt and a cursor line. */
export function ShellGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M3 4.75 6.25 8 3 11.25M8 11.25h5" />
    </Glyph>
  )
}

/** A command tab (a [+] menu entry): a small window with a prompt in it. */
export function CommandGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
      <path d="M5.25 7.25 7 8.75 5.25 10.25M8.5 10.25h2.25" />
      <path d="M2 5.25h12" />
    </Glyph>
  )
}

export function BackGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M9.75 3.75 5.5 8l4.25 4.25" strokeWidth="1.5" />
    </Glyph>
  )
}

export function ForwardGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M6.25 3.75 10.5 8l-4.25 4.25" strokeWidth="1.5" />
    </Glyph>
  )
}

export function ReloadGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M12.75 8a4.75 4.75 0 1 1-1.6-3.55" />
      <path d="M11.5 2.25v2.5H9" />
    </Glyph>
  )
}

export function ExternalGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5" />
      <path d="M11.75 9.5v2.75a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H6.5" />
    </Glyph>
  )
}

/** A changed file in the Sessions panel. */
export function FileGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M4.5 2.25h4.25L12 5.5v7.25a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1z" />
      <path d="M8.5 2.5v3.25H12" />
    </Glyph>
  )
}

/** Settings: a gear on a 24 grid (its teeth need the finer grid; 1.8 there is ~1.2 at 16px). */
export function GearGlyph(props: GlyphProps): React.JSX.Element {
  return (
    <Glyph {...props} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" strokeWidth="1.8" />
      <path
        strokeWidth="1.8"
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      />
    </Glyph>
  )
}
