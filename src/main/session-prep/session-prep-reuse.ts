/**
 * Session prep's "reuse before launching": before an item launches, a free session already doing
 * related work (`session find-owner`) is offered instead. Nothing is given away unattended: the
 * item waits, the person's click decides, and "Launch new" launches exactly as before.
 */

import { randomUUID } from 'node:crypto'
import type { SessionPrepReuseChoice } from '../../shared/session-prep-types'
import type { SessionOwnerScope } from '../session-manage/session-manage-owner'
import type {
  SessionPrepBatchRecord,
  SessionPrepItemRecord,
  SessionPrepItemReuse
} from './session-prep-records'

export type SessionPrepReuseOffer = Pick<
  SessionPrepItemReuse,
  'kind' | 'paneKey' | 'tabId' | 'title' | 'why' | 'ref' | 'cwd'
>

export type SessionPrepReuse = {
  /**
   * An existing session to offer instead of launching (a free related one that passed a dry run of
   * this prompt, one already doing it, or one busy editing its files), or a note on why none was.
   */
  find(input: {
    sourcePaneKey: string
    /** What the item asks for, judged against each session's goal. */
    task: string
    /** The exact prompt the session would receive. */
    prompt: string
    /** Files the prepared prompt references; a session editing them is the strongest owner. */
    files: readonly string[]
    scope: SessionOwnerScope
    exclude: ReadonlySet<string>
    /** New batch workspaces whose terminal handle has not yielded a stable pane key yet. */
    excludeWorktreeIds?: readonly string[]
  }): Promise<{ offer: SessionPrepReuseOffer } | { note?: string; hold?: boolean }>
  /** Delivers the prompt through `session assign`; throws with the reason when it cannot. */
  assign(input: {
    sourcePaneKey: string
    owner: Pick<SessionPrepItemReuse, 'paneKey' | 'tabId' | 'ref' | 'cwd'>
    prompt: string
    request: string
    reason: string
  }): Promise<void>
}

type ActiveReuseReservation = {
  index: number
  token: string
  done: Promise<void>
  resolve: () => void
}
const activeReservations = new Map<string, ActiveReuseReservation>()

/** Persist a single lookup owner before it reads the shared session inventory. */
export async function reserveSessionPrepReuse(
  batch: SessionPrepBatchRecord,
  index: number,
  now: number,
  persist: () => Promise<void>,
  cancelled: () => boolean
): Promise<(() => Promise<void>) | null> {
  for (;;) {
    if (cancelled()) {
      return null
    }
    const active = activeReservations.get(batch.id)
    if (active) {
      await active.done
      continue
    }
    if (batch.reuseReservation) {
      // A persisted reservation without its in-memory owner is ambiguous. Startup must reconcile.
      return null
    }
    let resolve!: () => void
    const done = new Promise<void>((finish) => {
      resolve = finish
    })
    const token = randomUUID()
    const reservation = { index, token, done, resolve }
    batch.reuseReservation = { index, startedAt: now, token }
    activeReservations.set(batch.id, reservation)
    try {
      await persist()
    } catch (error) {
      // The write may have reached disk despite its error; retain an ambiguous marker.
      if (activeReservations.get(batch.id) === reservation) {
        activeReservations.delete(batch.id)
      }
      resolve()
      throw error
    }
    return async () => {
      if (activeReservations.get(batch.id) !== reservation) {
        return
      }
      const held = batch.reuseReservation
      if (!held || held.token !== token) {
        activeReservations.delete(batch.id)
        resolve()
        return
      }
      delete batch.reuseReservation
      try {
        await persist()
      } catch (error) {
        batch.reuseReservation = held
        activeReservations.delete(batch.id)
        resolve()
        throw error
      }
      if (activeReservations.get(batch.id) === reservation) {
        activeReservations.delete(batch.id)
      }
      resolve()
    }
  }
}

/** Startup reconciles a stale on-disk reservation before pumping any sibling item. */
export async function reconcileSessionPrepReuseReservation(
  batch: SessionPrepBatchRecord,
  persist: () => Promise<void>
): Promise<void> {
  const held = batch.reuseReservation
  if (!held) {
    return
  }
  delete batch.reuseReservation
  try {
    await persist()
  } catch (error) {
    batch.reuseReservation = held
    const active = activeReservations.get(batch.id)
    if (active?.token === held.token) {
      activeReservations.delete(batch.id)
      active.resolve()
    }
    throw error
  }
  const active = activeReservations.get(batch.id)
  if (active?.token === held.token) {
    activeReservations.delete(batch.id)
    active.resolve()
  }
}

export function sessionPrepReuseTask(item: SessionPrepItemRecord): string {
  return `${item.fields?.title ?? item.planned.title}: ${item.planned.ask}`
}

/** The asker and every session already offered to or given another item of this batch. */
export function sessionPrepReuseExclusions(batch: SessionPrepBatchRecord): Set<string> {
  return new Set([
    batch.source.paneKey,
    ...batch.items.flatMap((entry) => (entry.launched?.paneKey ? [entry.launched.paneKey] : [])),
    ...batch.items.flatMap((entry) =>
      entry.reuse && entry.reuse.decided !== 'launch' ? [entry.reuse.paneKey] : []
    )
  ])
}

export function sessionPrepReuseDecisionError(
  item: SessionPrepItemRecord | undefined,
  choice: SessionPrepReuseChoice
): string | null {
  if (!item || item.state !== 'awaiting-reuse' || !item.reuse || !item.prompt) {
    return 'This session is not waiting for a choice.'
  }
  if (item.reuse.decided) {
    return 'This session already has a choice.'
  }
  if (choice === 'assign' && item.reuse.kind !== 'assign') {
    return 'That session was not offered to take this task; choose Launch anyway or leave it.'
  }
  if (choice === 'skip' && item.reuse.kind === 'assign') {
    return 'Choose to give it to that session or to launch a new one.'
  }
  return null
}
