// Ask Claude from a page tab (design-editor.md §4 "Ask Claude"): core's Discuss for page tabs. The
// page asks (`ccPanel.tab.discuss()`, the editor's Ctrl+L or its context menu); the shell draws the
// question box over the tab and sends `pageTabs.discuss { tabId, question, target }`. Main:
//
//   1. checks the tab is a page tab of the caller's project and the target a Claude tab of the
//      caller's window that would take the text (not ended, not idle), as overlay Discuss does;
//   2. asks the tab's plugin for the context: `pageTab.discuss` to its host, answered by the
//      instance of the CALLER's view (its selection is the one the person sees), within
//      DISCUSS_ASK_MS; a throw, a timeout or another shape than `{ text }` / null sends nothing;
//   3. composes `About: <title>`, the type line, the context, the question and the person's closing
//      prompt (discuss.ts composeDiscuss: it always starts with `About:`, so the gate's refusal of a
//      leading `/`, `!`, `#` or `&` never fires on it);
//   4. checks the target again (the ask may take seconds) and sends through the send gate as `core`
//      origin: the person typed the question and clicked Send, so a tab they have typed in takes it
//      (a plugin's own `sessions.send` is refused on such a tab, which is nearly every tab), or opens
//      a new session with it under Discuss's own budget; then selects the Claude tab.
//
// The renderer is not trusted with any of it: the tab and target ids are only looked up, the view
// is the one main bound the sender to, the question is checked here.
import { DISCUSS_ASK_MS, MAX_DISCUSS_QUESTION, type DiscussTarget } from '../../shared/discuss'
import { errorText } from '../../shared/error-text'
import type { DiscussAnswer } from '../../shared/ipc'
import type { JsonValue } from '../../sdk/types'
import { within } from '../../shared/timeout'
import { isRemoteViewId, type ViewId } from '../../shared/views'
import { composeDiscuss, deliverDiscuss, discussContextOf, discussTargetProblem, DiscussSessionBudget, type DiscussGuest } from '../overlays/discuss'
import type { DiscussSessions } from '../overlays/overlay-manager'

/** A page tab as Discuss needs it, from main's own record. */
export interface DiscussPageTab {
  id: string
  pluginId: string
  type: string
  title: string
  params?: JsonValue
}

export interface PageTabDiscussDeps {
  /** The page tab `tabId` of `projectId` (TabManager), or undefined for any other id. */
  pageTab(projectId: string, tabId: string): DiscussPageTab | undefined
  /**
   * The plugin's context for the tab in `view` (absent: the desktop's): HostManager.pageTabDiscuss,
   * `{ text }` or null. Bounded here by DISCUSS_ASK_MS as well.
   */
  askContext(projectId: string, tab: DiscussPageTab, view: ViewId | undefined): Promise<unknown>
  /** main's sessions, scoped to the caller's window (the same object overlay Discuss uses). */
  sessions: DiscussSessions
  /** The plugin's name for an error the person reads; its id when unknown. */
  pluginTitle?(pluginId: string): string
  log?(message: string): void
}

/** Who asks: the window, project and view main bound the sender to. */
export interface DiscussCaller {
  windowId: number
  projectId: string
  viewId: ViewId
}

/** The question as the box sent it: text within the cap; a blank one is no question. */
export function discussQuestionOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('the question must be text')
  if (value.length > MAX_DISCUSS_QUESTION) throw new Error(`the question is too long: at most ${MAX_DISCUSS_QUESTION} characters`)
  return value.trim() === '' ? undefined : value
}

/** A target as the renderer sent it, shape only (the tab is looked up later). */
export function discussTargetOf(value: unknown): DiscussTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { kind, tabId } = value as Record<string, unknown>
  if (kind === 'new') return { kind: 'new' }
  if (kind === 'tab' && typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 64) return { kind: 'tab', tabId }
  return undefined
}

export class PageTabDiscuss {
  /** Discuss's own New session budget per window, shared by every page tab of it. */
  private readonly budget = new DiscussSessionBudget()
  /** `<windowId>\n<viewId>\n<tabId>` being sent now: a double click sends once. */
  private readonly sending = new Set<string>()

  constructor(private readonly deps: PageTabDiscussDeps) {}

  /** The box's Send (see the top of the file). Never rejects: an error is the answer's text. */
  async discuss(caller: DiscussCaller, tabId: unknown, rawQuestion: unknown, rawTarget: unknown, guest?: DiscussGuest): Promise<DiscussAnswer> {
    if (typeof tabId !== 'string') return { ok: false, error: 'Ask Claude is not available on this tab' }
    const target = discussTargetOf(rawTarget)
    if (!target) return { ok: false, error: 'Pick a Claude session or a new one' }
    let question: string | undefined
    try {
      question = discussQuestionOf(rawQuestion)
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
    const tab = this.deps.pageTab(caller.projectId, tabId)
    if (!tab) return { ok: false, error: 'That tab is gone' }
    const { sessions } = this.deps
    const { windowId } = caller
    const early = discussTargetProblem(sessions, windowId, target)
    if (early) return { ok: false, error: early }
    const key = `${windowId}\n${caller.viewId}\n${tab.id}`
    if (this.sending.has(key)) return { ok: false, error: 'Already sending' }
    this.sending.add(key)
    try {
      const name = this.deps.pluginTitle?.(tab.pluginId) ?? tab.pluginId
      let answer: unknown
      try {
        const view = isRemoteViewId(caller.viewId) ? caller.viewId : undefined
        answer = await within(this.deps.askContext(caller.projectId, tab, view), DISCUSS_ASK_MS, `it took longer than ${DISCUSS_ASK_MS / 1000} s`)
      } catch (err) {
        return { ok: false, error: `${name} could not give its context: ${errorText(err)}` }
      }
      const parsed = discussContextOf(answer)
      if (!parsed) return { ok: false, error: `${name} answered with something other than { text } or null` }
      const context = parsed.context
      // The tab may have closed while its plugin was asked: its title is read again, and a gone tab sends nothing.
      const now = this.deps.pageTab(caller.projectId, tab.id)
      if (!now) return { ok: false, error: 'That tab closed' }
      const type = { name: now.type, data: now.params ?? null }
      const text = composeDiscuss({
        title: now.title,
        type,
        ...(context !== undefined ? { context } : {}),
        ...(question !== undefined ? { question } : {}),
        prompt: sessions.prompt?.(windowId)
      })
      const late = discussTargetProblem(sessions, windowId, target)
      if (late) return { ok: false, error: late }
      const sent = await deliverDiscuss(sessions, this.budget, windowId, target, text, guest)
      if (!sent.ok) return sent
      const sentTo = sent.tabId
      try {
        if (guest === undefined) sessions.selectTab(windowId, sentTo)
        else sessions.selectTab(windowId, sentTo, guest.viewId)
      } catch (err) {
        this.deps.log?.(`page tab ${tab.id}: selecting tab ${sentTo} failed: ${errorText(err)}`)
      }
      return sent
    } finally {
      this.sending.delete(key)
    }
  }

  /** The window closed: its New session budget goes. */
  forget(windowId: number): void {
    this.budget.forget(windowId)
  }
}
