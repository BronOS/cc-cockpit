// Inline SVG artwork for the project picker. The app icon is drawn here rather than loaded from
// build/icon.png: the renderer has no protocol that serves build/ in a packaged app, and an inline
// copy is crisp at any size without shipping another asset.
import { useId } from 'react'

/**
 * build/icon.svg's artwork, cropped to the tile (the source keeps the macOS grid's 100px margin,
 * which would shrink the tile at 56px) and without its drop shadow, which is meant for the Dock.
 * Keep it in step with build/icon.svg.
 */
export function AppIcon({ size = 56 }: { size?: number }): React.JSX.Element {
  // Gradient ids are document-wide; useId keeps two icons on one page from sharing them. React's
  // ids contain characters (`«»`, `:`) that url(#...) does not take unescaped, so strip them.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const tile = `${uid}-tile`
  const rim = `${uid}-rim`
  const clay = `${uid}-clay`
  const glow = `${uid}-glow`
  return (
    <svg className="app-icon" width={size} height={size} viewBox="100 100 824 824" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a2725" />
          <stop offset="1" stopColor="#141312" />
        </linearGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id={clay} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#c4633f" />
          <stop offset="1" stopColor="#ec9a76" />
        </linearGradient>
        <radialGradient id={glow} cx="0.5" cy="0.52" r="0.5">
          <stop offset="0" stopColor="#d97757" stopOpacity="0.22" />
          <stop offset="1" stopColor="#d97757" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${tile})`} />
      <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke={`url(#${rim})`} strokeWidth="3" />
      <circle cx="512" cy="500" r="330" fill={`url(#${glow})`} />
      <g fill="none" strokeLinecap="round">
        <path d="M 295.5 625 A 250 250 0 1 1 728.5 625" stroke="#3a3633" strokeWidth="34" />
        <path d="M 295.5 625 A 250 250 0 0 1 689 323" stroke={`url(#${clay})`} strokeWidth="34" />
      </g>
      <g stroke="#5d5751" strokeWidth="9" strokeLinecap="round">
        <line x1="512" y1="282" x2="512" y2="304" />
        <line x1="358" y1="346" x2="373" y2="361" />
        <line x1="666" y1="346" x2="651" y2="361" />
        <line x1="294" y1="500" x2="316" y2="500" />
        <line x1="730" y1="500" x2="708" y2="500" />
      </g>
      <line x1="512" y1="500" x2="648" y2="364" stroke="#f3ede8" strokeWidth="20" strokeLinecap="round" />
      <circle cx="512" cy="500" r="34" fill="#f3ede8" />
      <circle cx="512" cy="500" r="13" fill="#d97757" />
      <path
        d="M 432 676 L 476 712 L 432 748"
        fill="none"
        stroke={`url(#${clay})`}
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="504" y="724" width="92" height="26" rx="8" fill="#f3ede8" />
    </svg>
  )
}

/** A folder outline, 16px, in the current text colour. */
export function FolderGlyph(): React.JSX.Element {
  return (
    <svg className="picker-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44L8.3 4.5h4.2A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A magnifier for the filter field, 14px, in the current text colour. */
export function SearchGlyph(): React.JSX.Element {
  return (
    <svg className="picker-search-glyph" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
