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
// A select inside a cross-site (out-of-process) iframe: the off-screen view's router (page-input.ts
// `scriptAt`) runs hitScript in the document its own route for the press picks, the point in that
// frame's px, in an isolated world made on the frame's own DevTools session; the rectangle comes back
// mapped to the top page through the owner boxes that route read (selectHitInTop), and the popup id
// is bound to that frame (SelectFrames) so chooseScript runs there and nowhere else: a frame gone or
// replaced meanwhile (a new document has a fresh world, the WeakRef is not found) chooses nothing.
//
// A select inside a same-origin iframe (same process, so the router's route ends in the document
// holding the frame element, where elementFromPoint stops at that element): hitScript itself steps
// into the frame's `contentDocument` (readable from the isolated world for a same-origin frame
// only: null for a cross-origin one, same-site or not, and for a sandboxed one without
// allow-same-origin, where the walk stops as before), the point moved into the frame's viewport
// through the frame element's content box (its border and padding; the frame's own scroll is in its
// viewport coordinates already), at any depth, under the top document or under a cross-site frame's
// (the script runs in whichever the router picked). Only a frame whose boxes are at most translated
// is stepped into: a scale, rotation, skew, 3D transform, motion path, CSS zoom or SVG ancestor has
// no exact inverse here (the DOM gives no box corners to map through, as the router's three-corner
// parallelogram does for a cross-site frame), so such a press gets no popup and goes to the page, as
// before, rather than a popup over the wrong place. The rectangle goes back by the same offsets. The
// kept element sits in a child document the world's registry outlives (a same-origin frame that
// navigates keeps its parent's world), so chooseScript checks the frame chain from the select's
// document up to the script's own is still the one the hit walked (each frame element connected and
// holding that document): a frame navigated, replaced or removed meanwhile chooses nothing.
//
// Not covered, keyboard-only as before: a select inside a same-site but cross-origin iframe or a
// sandboxed one (both in the page's process, their documents unreadable from the isolated world:
// that would need the router to make a world in the frame by id, backlog
// streamed-clicks-miss-cross-site-iframes.md), a same-origin frame under a transform other than a
// translation (above), a select inside a closed shadow root, a listbox (`multiple` or `size` > 1,
// which is painted in the page and clicked there), and a custom dropdown a page builds itself
// (painted like any element, nothing to do).
//
// Pure: the scripts are strings built from main's own numbers and ids; parseHitResult,
// selectHitInTop, SelectFrames and SelectPopups (the one open popup per view and panel) have no Electron.

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
/**
 * Most same-origin frames hitScript steps into below the document it runs in (and chooseScript walks
 * back up): a deeper select is no hit. Chromium's own nesting limit is far above; a page nesting this
 * deep for a select is not one a person uses.
 */
export const MAX_SAME_ORIGIN_DEPTH = 16
/** Most boxes checked from a frame element up to its document's root (a deeper frame is no hit). */
export const MAX_FRAME_ANCESTORS = 512

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
 * open shadow roots and same-origin frames (frameOffset); a select it is (or is in) that a click
 * would open as a popup: enabled (a disabled fieldset counts, `:disabled`), not `multiple`, `size`
 * ≤ 1. Then its options (hidden ones skipped, each with its index in `select.options`; the first
 * MAX_SELECT_OPTIONS, labels cut here before they cross), the selected index, its rectangle in this
 * document's viewport CSS px (a same-origin frame's offsets added back), and it takes the focus as a
 * click would. Anything else returns null. The element is kept under `id` for chooseScript.
 */
export function hitScript(x: number, y: number, id: string): string {
  return `(() => {
  const x = ${numberOf(x)}, y = ${numberOf(y)}, id = ${idOf(id)};
  const tagOf = (el) => el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  // A same-origin frame's document (null for a cross-origin or sandboxed one: unreadable here).
  const frameDoc = (el) => {
    const tag = tagOf(el);
    if (tag !== 'IFRAME' && tag !== 'FRAME') return null;
    try { return el.contentDocument || null; } catch (e) { return null; }
  };
  // Every box from the frame element up to its document's root (through slots and shadow hosts)
  // at most translated: a 2D translation matrix, no rotate or scale, a translate with no z (under an
  // ancestor's perspective a z scales), no motion path, zoom 1, no SVG. Anything else has no exact
  // inverse from what the DOM gives, so the frame is not stepped into.
  const translatedOnly = (el, view) => {
    let n = 0;
    for (let a = el; a; a = a.assignedSlot || a.parentElement || (a.parentNode && a.parentNode.host) || null) {
      if (++n > ${MAX_FRAME_ANCESTORS}) return false;
      if (a.namespaceURI === 'http://www.w3.org/2000/svg') return false;
      const cs = view.getComputedStyle(a);
      const t = String(cs.transform || 'none');
      if (t !== 'none' && t.indexOf('matrix(1, 0, 0, 1, ') !== 0) return false;
      if ((cs.rotate || 'none') !== 'none' || (cs.scale || 'none') !== 'none') return false;
      const tr = String(cs.translate || 'none');
      if (tr !== 'none' && tr.split(' ').filter((p) => p !== '').length > 2) return false;
      if ((cs.offsetPath || 'none') !== 'none') return false;
      const z = String(cs.zoom || '1');
      if (z !== '1' && z !== 'normal') return false;
    }
    return true;
  };
  // The frame's viewport origin in its owner document's viewport: its border box's corner plus its
  // left and top border and padding. Null when that is not exact: a transform (above), or a box
  // whose drawn size is not its layout size, or a viewport not the content box's size (a scale the
  // style walk did not name), each within a pixel (offsetWidth is rounded).
  const frameOffset = (el) => {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    if (!view || !translatedOnly(el, view)) return null;
    const cs = view.getComputedStyle(el);
    const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth), pl = px(cs.paddingLeft), pt = px(cs.paddingTop);
    const pr = px(cs.paddingRight), pb = px(cs.paddingBottom);
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - el.offsetWidth) > 1 || Math.abs(r.height - el.offsetHeight) > 1) return null;
    const inner = el.contentWindow;
    if (!inner || Math.abs(inner.innerWidth - (el.clientWidth - pl - pr)) > 1 || Math.abs(inner.innerHeight - (el.clientHeight - pt - pb)) > 1) return null;
    const ox = r.left + bl + pl, oy = r.top + bt + pt;
    return Number.isFinite(ox) && Number.isFinite(oy) ? { x: ox, y: oy } : null;
  };
  let doc = document, px = x, py = y, dx = 0, dy = 0, el = null;
  for (let depth = 0; ; depth++) {
    el = doc.elementFromPoint(px, py);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === el) break;
      el = inner;
    }
    const inner = el ? frameDoc(el) : null;
    if (!inner) break;
    if (depth >= ${MAX_SAME_ORIGIN_DEPTH}) return null;
    const at = frameOffset(el);
    if (!at) return null;
    px -= at.x; py -= at.y; dx += at.x; dy += at.y;
    doc = inner;
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
  return { select: true, options, selected: select.selectedIndex, rect: { x: r.left + dx, y: r.top + dy, width: r.width, height: r.height } };
})()`
}

/**
 * The answer to popup `id`, run in WEBVIEW_WORLD_ID: `index` null forgets the element; a number
 * sets it as the select's choice when the select is still in the page (its own document still
 * connected to the script's through the same frames: each frame element in place and holding that
 * document, so a same-origin frame navigated or removed since chooses nothing; isConnected alone
 * stays true in a document its frame left), still enabled and single, and the option exists and is
 * not disabled (nor in a disabled group), then fires `input` and `change` (bubbling, as a person's
 * choice does; untrusted events, `isTrusted` false). The same index again changes nothing and fires
 * nothing, like a native select. True when it was set.
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
  let d = select.ownerDocument;
  for (let n = 0; d !== document; n++) {
    const view = d && d.defaultView;
    const owner = view ? view.frameElement : null;
    if (n >= ${MAX_SAME_ORIGIN_DEPTH} || !owner || !owner.isConnected || owner.contentDocument !== d) return false;
    d = owner.ownerDocument;
  }
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

/**
 * hitScript's raw result from a frame, its rectangle in the top page's viewport (`toTop`, the
 * router's mapping through the route's owner boxes): unchanged when it is no hit (null and the like:
 * parseHitResult says no select), undefined when the rectangle cannot be mapped (malformed, or a
 * box the router refuses: then the press goes to the page as a click). Still the page's data:
 * parseHitResult checks the rest.
 */
export function selectHitInTop(raw: unknown, toTop: (rect: unknown) => WebviewSelectRect | undefined): unknown {
  if (!isPlainObject(raw) || raw.select !== true) return raw
  const rect = toTop(raw.rect)
  return rect ? { ...raw, rect } : undefined
}

/**
 * The frame each popup's select was found in (page-input.ts ScriptFrame), by popup id, so its answer
 * runs there: at most REGISTRY_CAP (as the isolated world's registry; old ids go first), taken once.
 */
export class SelectFrames<F> {
  private readonly frames = new Map<string, F>()

  remember(id: string, frame: F): void {
    this.frames.delete(id)
    this.frames.set(id, frame)
    while (this.frames.size > REGISTRY_CAP) this.frames.delete(this.frames.keys().next().value as string)
  }

  /** The frame of popup `id` (undefined: none, or taken already); forgotten by this. */
  take(id: string): F | undefined {
    const frame = this.frames.get(id)
    this.frames.delete(id)
    return frame
  }
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
