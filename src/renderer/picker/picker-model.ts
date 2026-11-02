// The project picker's pure logic: how a path is shown, what the filter keeps, where the keyboard
// highlight goes. DOM-free so the unit tests (plain Node) cover it.
import type { ProjectSummary } from '../../shared/ipc'

/**
 * `path` with the home folder written as `~` (`/Users/me/src/app` -> `~/src/app`). Only a whole
 * leading folder counts: `/Users/meg` is not under `/Users/me`. A home of `/` (or none) shortens
 * nothing, since every path would turn into `~...`.
 */
export function tildePath(path: string, home: string | undefined): string {
  if (!home) return path
  const base = home.replace(/[/\\]+$/, '')
  if (base === '') return path
  if (path === base) return '~'
  const next = path.charAt(base.length)
  if (path.startsWith(base) && (next === '/' || next === '\\')) return '~' + path.slice(base.length)
  return path
}

/**
 * The recent projects whose name or path contains `query`, ignoring case and the surrounding
 * spaces, in their recent order. The `~` form of the path matches too, since that is what the row
 * shows: typing `~/src` finds what is listed as `~/src/...`.
 */
export function filterProjects(projects: readonly ProjectSummary[], query: string, home: string | undefined): ProjectSummary[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...projects]
  return projects.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      tildePath(p.path, home).toLowerCase().includes(q)
  )
}

/** The first row Enter can open (a missing folder cannot be opened), or -1. */
export function firstOpenable(rows: readonly Pick<ProjectSummary, 'missing'>[]): number {
  return rows.findIndex((r) => !r.missing)
}

/**
 * Where ↑ (`step` -1) or ↓ (+1) moves the highlight from `from`: the next openable row that way,
 * skipping missing ones (Enter could not open them; their Relink/Forget buttons are reached with
 * Tab). It stops at the ends rather than wrapping, so holding ↓ settles on the last row. With
 * nothing highlighted (-1) either key lands on the first openable row.
 */
export function moveHighlight(rows: readonly Pick<ProjectSummary, 'missing'>[], from: number, step: 1 | -1): number {
  if (from < 0 || from >= rows.length) return firstOpenable(rows)
  for (let i = from + step; i >= 0 && i < rows.length; i += step) {
    if (!rows[i]!.missing) return i
  }
  return from
}
