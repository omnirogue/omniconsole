import { deriveGeneratedTabTitle, truncateAtWordBoundary } from '../../shared/agent-tab-title'
import { sessionBatchRequestExcerpt } from '../../shared/session-batch-origin'
import { shortSessionPrepReason } from './session-prep-ids'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'

/**
 * One request that launches two or more sessions with no folder named gets one Active folder,
 * "Launch · 09:25 · Fix PDF export", created before its first launch. A single launch gets none.
 */

export const SESSION_PREP_BATCH_FOLDER_NAME_LIMIT = 60

export type SessionPrepBatchFolder =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: string }

function clockLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `attempt` above 1 appends " · <attempt>", so a same-minute repeat never matches an existing folder. */
export function sessionPrepBatchFolderName(request: string, at: number, attempt = 1): string {
  const prefix = `Launch · ${clockLabel(at)}`
  const suffix = attempt > 1 ? ` · ${attempt}` : ''
  const clause = deriveGeneratedTabTitle(request)
  if (!clause) {
    return `${prefix}${suffix}`
  }
  const room = SESSION_PREP_BATCH_FOLDER_NAME_LIMIT - prefix.length - suffix.length - ' · '.length
  const fitted = truncateAtWordBoundary(clause, room)
  return fitted ? `${prefix} · ${fitted}${suffix}` : `${prefix}${suffix}`
}

/** Items that go to the batch folder: the ones the person named no folder for. */
function unnamedItems(batch: SessionPrepBatchRecord): SessionPrepItemRecord[] {
  return batch.items.filter((item) => !item.planned.choices?.folder && item.state !== 'cancelled')
}

export function sessionPrepWantsBatchFolder(batch: SessionPrepBatchRecord): boolean {
  return !batch.defaultFolder && unnamedItems(batch).length >= 2
}

// Why per record: sibling items launch concurrently and must share one folder, not race to make two.
const pending = new WeakMap<SessionPrepBatchRecord, Promise<SessionPrepBatchFolder>>()

/** The batch's folder for `item`, creating it once; null when the item goes elsewhere or alone. */
export function sessionPrepBatchFolder(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord
): Promise<SessionPrepBatchFolder> | null {
  if (item.planned.choices?.folder || !sessionPrepWantsBatchFolder(batch)) {
    return null
  }
  if (batch.batchFolder) {
    return Promise.resolve({ ok: true, ...batch.batchFolder })
  }
  let created = pending.get(batch)
  if (!created) {
    created = createBatchFolder(ctx, batch)
    pending.set(batch, created)
  }
  return created
}

async function createBatchFolder(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord
): Promise<SessionPrepBatchFolder> {
  const at = ctx.now()
  try {
    const folder = await ctx.host.createBatchFolder({
      name: (attempt) => sessionPrepBatchFolderName(batch.request, at, attempt),
      origin: {
        batchId: batch.id,
        requestExcerpt: sessionBatchRequestExcerpt(batch.request),
        createdAt: at,
        source: 'session-prep'
      }
    })
    // Why persisted: a batch resumed after a restart files into this folder, not a look-alike.
    batch.batchFolder = { id: folder.id, path: folder.path }
    await ctx.persist()
    return { ok: true, ...batch.batchFolder }
  } catch (error) {
    return { ok: false, reason: shortSessionPrepReason(error) }
  }
}
