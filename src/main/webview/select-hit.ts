// `<select>` popups of a streamed webview (design-web-browser.md §4.4; plan
// 20261111-streamed-webviews.md Task 9).
//
// The off-screen page never paints a select's popup (the spike, §2): a click opens it invisibly and
// only the keyboard can work it. So before a left press reaches the page, main asks the page what is
// under the point (hitScript), in main's own isolated world (WEBVIEW_WORLD_ID, the selection
// reader's): the page's scripts can neither see the call nor stand in for `elementFromPoint`. A
// closed, enabled, single-choice select under the point means the press and its release do not go
// to the page; the same call returns the select's options and rectangle, the clicking browser view
// draws its own dropdown (`webviews.select`), and its answer (`webviews.selectChoose`) comes back
// with the id main gave that popup. chooseScript then finds the same element again (the isolated
// world keeps a WeakRef to it under that id, in globals the page's main world cannot reach), sets
// `selectedIndex` and fires `input` and `change`, as a person's choice would. No channel from the
// page to main exists, so nothing here can be forged by the page; what comes back is still the
// page's text (labels) and is cleaned and capped (parseHitResult) before it goes out.
//
// Not covered, keyboard-only as before: a select inside an iframe (elementFromPoint stops at the
// frame element, and a cross-origin frame's document is not ours to walk), a select inside a closed
// shadow root, a listbox (`multiple` or `size` > 1, which is painted in the page and clicked there),
// and a custom dropdown a page builds itself (painted like any element, nothing to do).
//
// Pure: the scripts are strings built from main's own numbers and ids; parseHitResult and
// SelectPopups (the one open popup per view and panel) have no Electron.

import { randomBytes } from 'node:crypto'
import { isPlainObject } from '../../shared/guards'
import type { WebviewSelectOption, WebviewSelectRect } from '../../shared/ipc'

/** Most options a popup lists (the first ones in the select's order). */
export const MAX_SELECT_OPTIONS = 500
/** Most UTF-16 units of one option's label or one group's label. */
export const MAX_OPTION_LABEL = 200
/**
 * How long a press waits for its hit-test before it goes to the page anyway (a busy or hung page):
 * the person's click must not stall, and a select missed this way still works by keyboard.
 */
export const HIT_TIMEOUT_MS = 50
/** Most events held behind one hit-test (more is a burst no browser of ours sends in 50 ms). */
export const MAX_HELD_EVENTS = 256
/** Largest rectangle coordinate passed on (CSS px either way; a page can be scrolled far). */
const MAX_RECT = 100_000
/** Entries the isolated world's registry keeps (one popup per view and panel; old ids go first). */
const REGISTRY_CAP = 16
/** The isolated world's global holding the selects by popup id. */
const REGISTRY = '__ccCockpitSelects'

/** A popup id: main's random hex, the only thing of a choice the scripts embed besides numbers. */
const ID_PATTERN = /^[0-9a-f]{32}$/

export function newSelectId(): string {
  return randomBytes(16).toString('hex')
}

function idOf(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('select: bad popup id')
  return JSON.stringify(id)
}

function numberOf(v: number): string {
  if (!Number.isFinite(v)) throw new Error('select: bad number')
  return JSON.stringify(v)
}

/**
 * The hit-test at page CSS px (x, y), run in WEBVIEW_WORLD_ID: the element under the point, into
 * open shadow roots; a select it is (or is in) that a click would open as a popup: enabled (a
 * disabled fieldset counts, `:disabled`), not `multiple`, `size` ≤ 1. Then its options (hidden ones
 * skipped, each with its index in `select.options`; the first MAX_SELECT_OPTIONS, labels cut here
 * before they cross), the selected index, its rectangle in viewport CSS px, and it takes the focus
 * as a click would. Anything else returns null. The element is kept under `id` for chooseScript.
 */
export function hitScript(x: number, y: number, id: string): string {
  return `(() => {
  const x = ${numberOf(x)}, y = ${numberOf(y)}, id = ${idOf(id)};
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  const select = el && typeof el.closest === 'function' ? el.closest('select') : null;
  if (!select || select.multiple || select.size > 1 || select.matches(':disabled')) return null;
  const cut = (s) => String(s == null ? '' : s).slice(0, ${MAX_OPTION_LABEL * 2}).trim().slice(0, ${MAX_OPTION_LABEL});
  const options = [];
  const all = select.options;
  const n = Math.min(all.length, ${MAX_SELECT_OPTIONS});
  for (let i = 0; i < n; i++) {
    const o = all[i];
    if (o.hidden) continue;
    const parent = o.parentElement;
    const group = parent && parent.tagName === 'OPTGROUP' ? parent : null;
    const item = { index: i, label: cut(o.label || o.text), disabled: !!(o.disabled || (group && group.disabled)) };
    if (group) item.group = cut(group.label);
    options.push(item);
  }
  const reg = globalThis.${REGISTRY} || (globalThis.${REGISTRY} = new Map());
  reg.delete(id);
  reg.set(id, new WeakRef(select));
  while (reg.size > ${REGISTRY_CAP}) reg.delete(reg.keys().next().value);
  try { select.focus({ preventScroll: true }); } catch (e) {}
  const r = select.getBoundingClientRect();
  return { select: true, options, selected: select.selectedIndex, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
})()`
}

/**
 * The answer to popup `id`, run in WEBVIEW_WORLD_ID: `index` null forgets the element; a number
 * sets it as the select's choice when the select is still in the page, still enabled and single,
 * and the option exists and is not disabled (nor in a disabled group), then fires `input` and
 * `change` (bubbling, as a person's choice does; untrusted events, `isTrusted` false). The same
 * index again changes nothing and fires nothing, like a native select. True when it was set.
 */
export function chooseScript(id: string, index: number | null): string {
  const at = index === null ? 'null' : numberOf(index)
  return `(() => {
  const id = ${idOf(id)}, index = ${at};
  const reg = globalThis.${REGISTRY};
  const ref = reg ? reg.get(id) : undefined;
  if (reg) reg.delete(id);
  const select = ref ? ref.deref() : undefined;
  if (index === null || !select || !select.isConnected) return false;
  if (select.multiple || select.size > 1 || select.matches(':disabled')) return false;
  const o = select.options[index];
  if (!o) return false;
  const parent = o.parentElement;
  if (o.disabled || (parent && parent.tagName === 'OPTGROUP' && parent.disabled)) return false;
  if (select.selectedIndex === index) return false;
  select.selectedIndex = index;
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`
}

/** A hit on a select, as main passes it on (`webviews.select` without the panel and the id). */
export interface SelectHit {
  options: WebviewSelectOption[]
  /** The selected index in `select.options` (-1: none). */
  selected: number
  /** The select's rectangle, viewport CSS px of the page. */
  rect: WebviewSelectRect
}

// Every C0 and C1 control and DEL (a label is one line, so tabs and line breaks too).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

function label(v: unknown): string {
  if (typeof v !== 'string') return ''
  // The script cut it; cut again (it is still the page's text), no control characters (a label of
  // them, JSON-escaped at six bytes each, would grow the event; each is a space) and no lone
  // surrogate (U+FFFD).
  return v.slice(0, MAX_OPTION_LABEL).replace(CONTROL, ' ').replace(LONE_SURROGATE, '\ufffd')
}

function rectNumber(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.max(-MAX_RECT, Math.min(MAX_RECT, v))
}

/**
 * hitScript's result as main passes it on, or undefined (no select there, or a result that is not
 * what the script returns: then the press goes to the page). Options: at most MAX_SELECT_OPTIONS,
 * each with an integer index in [0, MAX_SELECT_OPTIONS) given once and in order, labels cleaned
 * and capped; any malformed option drops the whole hit. `selected` an index or -1; the rectangle
 * finite, clamped, its sides not negative.
 */
export function parseHitResult(raw: unknown): SelectHit | undefined {
  if (!isPlainObject(raw) || raw.select !== true) return undefined
  if (!Array.isArray(raw.options) || raw.options.length > MAX_SELECT_OPTIONS) return undefined
  const options: WebviewSelectOption[] = []
  let previous = -1
  for (const o of raw.options) {
    if (!isPlainObject(o)) return undefined
    const index = o.index
    if (typeof index !== 'number' || !Number.isInteger(index) || index <= previous || index >= MAX_SELECT_OPTIONS) return undefined
    previous = index
    if (typeof o.label !== 'string' || typeof o.disabled !== 'boolean') return undefined
    if (o.group !== undefined && typeof o.group !== 'string') return undefined
    const option: WebviewSelectOption = { index, label: label(o.label), disabled: o.disabled }
    if (typeof o.group === 'string') option.group = label(o.group)
    options.push(option)
  }
  const selected = typeof raw.selected === 'number' && Number.isInteger(raw.selected) && raw.selected >= -1 ? raw.selected : -1
  if (!isPlainObject(raw.rect)) return undefined
  const x = rectNumber(raw.rect.x)
  const y = rectNumber(raw.rect.y)
  const width = rectNumber(raw.rect.width)
  const height = rectNumber(raw.rect.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { options, selected, rect: { x, y, width: Math.max(0, width), height: Math.max(0, height) } }
}

/** One open popup: its id, and the indices the browser may answer with (listed, not disabled). */
export interface OpenSelect {
  id: string
  choosable: ReadonlySet<number>
}

/**
 * The open popup of each browser view and panel: at most one (a new hit replaces it, the browser
 * closes its old dropdown for the panel), taken once by its answer. An answer with any other id (an
 * old popup's, a made-up one, another view's) finds nothing.
 */
export class SelectPopups {
  private readonly open = new Map<string, Map<string, OpenSelect>>()

  set(viewId: string, panel: string, hit: SelectHit, id: string): void {
    let byPanel = this.open.get(viewId)
    if (!byPanel) {
      byPanel = new Map()
      this.open.set(viewId, byPanel)
    }
    byPanel.set(panel, { id, choosable: new Set(hit.options.filter((o) => !o.disabled).map((o) => o.index)) })
  }

  /** The popup when `id` is the view's current one for the panel; it is closed by this. */
  take(viewId: string, panel: string, id: unknown): OpenSelect | undefined {
    const byPanel = this.open.get(viewId)
    const current = byPanel?.get(panel)
    if (!current || typeof id !== 'string' || id !== current.id) return undefined
    byPanel?.delete(panel)
    if (byPanel?.size === 0) this.open.delete(viewId)
    return current
  }

  viewGone(viewId: string): void {
    this.open.delete(viewId)
  }
}
