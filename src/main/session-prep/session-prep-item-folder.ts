import type { SessionBatchSessionOrigin } from '../../shared/session-batch-origin'
import type { SessionPrepLaunchedSurface } from './session-prep-folders'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import { shortSessionPrepReason } from './session-prep-ids'

/** Explicit placement wins; an inherited project is an existing ID, never a new folder name. */
export async function sessionPrepItemFolder(
  host: SessionPrepHost,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord
): Promise<{ ref?: string | { id: string; path: string }; notes: string[] }> {
  if (item.planned.choices?.folder) {
    return { ref: item.planned.choices.folder, notes: [] }
  }
  if (!batch.defaultFolder) {
    return { notes: [] }
  }
  try {
    if (!host.resolveExistingFolder) {
      throw new Error('This host cannot resolve the project folder.')
    }
    return { ref: await host.resolveExistingFolder(batch.defaultFolder), notes: [] }
  } catch (error) {
    return { notes: [`Project folder not inherited or filed: ${shortSessionPrepReason(error)}`] }
  }
}

// Why never fail the item: the session already runs; an unfiled row is the worst outcome.
export async function fileSessionPrepItem(
  host: SessionPrepHost,
  item: SessionPrepItemRecord,
  folder: {
    ref: string | { id: string; path: string }
    label: string
    origin?: SessionBatchSessionOrigin
  },
  surface: SessionPrepLaunchedSurface | undefined,
  request: string
): Promise<void> {
  try {
    if (!surface) {
      throw new Error('the new session has no sidebar row yet')
    }
    item.filedIn = (
      await host.fileSession({
        folder: folder.ref,
        surface,
        ...(folder.origin ? { origin: folder.origin } : {}),
        request
      })
    ).path
  } catch (error) {
    addSessionPrepItemNotes(item, [
      `Not filed in “${folder.label}”: ${shortSessionPrepReason(error)}`
    ])
  }
}

export function addSessionPrepItemNotes(item: SessionPrepItemRecord, notes: string[]): void {
  if (notes.length > 0) {
    item.note = [item.note, ...notes].filter(Boolean).join(' · ')
  }
}
