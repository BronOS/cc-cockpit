// Ask's model and effort pick (decision D3, spec-review S5): remembered app-wide once the owner picked, and the default
// of every later chat. Main's own file, `<data>/ask.json`, written one change at a time by main (JsonFile, flushed at
// once: a pick is rare and must survive a quit right after it). Separate from the editor's quick chat pick
// (`quickChatPick` in that plugin's appStorage): one is a plugin's, this is core's.
//
// Only the owner's pick is saved (the caller decides with `isOwner(view)`); a guest's pick holds for its own chat only.
// What the file holds is checked on every read against the closed lists (shared/session-options.ts): a hand-edited
// value off the lists reads as no pick, never reaches an argv.
import { join } from 'node:path'
import { checkSessionOptions, SESSION_EFFORTS, SESSION_MODELS } from '../../shared/session-options'
import type { AskPickState } from '../../shared/overlay-envelope'
import { JsonFile } from '../store/json-file'

export interface AskPick {
  model?: string
  effort?: string
}

interface AskPickFile {
  schemaVersion: number
  model?: unknown
  effort?: unknown
}

/** The pick on the lists, or the fields that are not dropped. */
export function cleanPick(raw: { model?: unknown; effort?: unknown }): AskPick {
  const out: AskPick = {}
  const model = checkSessionOptions({ model: raw.model })
  if (model.ok && model.model !== undefined) out.model = model.model
  const effort = checkSessionOptions({ effort: raw.effort })
  if (effort.ok && effort.effort !== undefined) out.effort = effort.effort
  return out
}

/** The page's view of a pick: the pick plus the lists it may choose from. */
export function pickState(pick: AskPick): AskPickState {
  return {
    ...(pick.model !== undefined ? { model: pick.model } : {}),
    ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
    models: SESSION_MODELS,
    efforts: SESSION_EFFORTS
  }
}

export class AskPickStore {
  private readonly file: JsonFile<AskPickFile>

  constructor(dataDir: string, log: (message: string) => void) {
    this.file = new JsonFile<AskPickFile>({ filePath: join(dataDir, 'ask.json'), defaults: () => ({ schemaVersion: 1 }), log })
  }

  /** The remembered pick (checked against the lists). */
  get(): AskPick {
    return cleanPick(this.file.data)
  }

  /** Remember the owner's pick (already checked by the caller; checked again). Written at once. */
  set(pick: AskPick): void {
    const clean = cleanPick(pick)
    this.file.update((data) => {
      delete data.model
      delete data.effort
      if (clean.model !== undefined) data.model = clean.model
      if (clean.effort !== undefined) data.effort = clean.effort
    })
    this.file.flush()
  }
}
