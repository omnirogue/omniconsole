/**
 * `<userData>/session-pending-deliveries.json`: prompts held for a busy session. Every state
 * change is written durably before the next step runs, so a restart knows which were sent, which
 * still wait, and which were cut off mid-send (`unknown`, never sent again).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isSessionPendingDeliverySettled,
  type SessionPendingDelivery
} from '../../shared/session-pending-delivery-types'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const SESSION_PENDING_DELIVERIES_FILE = 'session-pending-deliveries.json'
/** Waiting prompts at once; a runaway caller is refused rather than filling the file. */
export const SESSION_PENDING_MAX_WAITING = 50
/** Settled ones stay readable (`omni session pending --all`) for this long. */
export const SESSION_PENDING_SETTLED_KEEP_MS = 7 * 24 * 60 * 60_000

type PendingFile = { version: 1; deliveries: SessionPendingDelivery[] }

export type SessionPendingDeliveriesStore = {
  load(): Promise<SessionPendingDelivery[]>
  list(): SessionPendingDelivery[]
  get(id: string): SessionPendingDelivery | undefined
  /** Adds and writes it; throws when the file cannot be written (no record, no hold). */
  add(delivery: SessionPendingDelivery): Promise<void>
  update(id: string, patch: Partial<SessionPendingDelivery>): Promise<SessionPendingDelivery>
}

export function createSessionPendingDeliveriesStore(
  userDataPath: string,
  now: () => number = Date.now
): SessionPendingDeliveriesStore {
  const path = join(userDataPath, SESSION_PENDING_DELIVERIES_FILE)
  let deliveries: SessionPendingDelivery[] = []
  let writes: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const cutoff = now() - SESSION_PENDING_SETTLED_KEEP_MS
    deliveries = deliveries.filter(
      (entry) => !isSessionPendingDeliverySettled(entry) || (entry.settledAt ?? now()) >= cutoff
    )
    const payload = JSON.stringify({ version: 1, deliveries } satisfies PendingFile, null, 2)
    // Writes are serialized so an older snapshot never lands after a newer one.
    const write = writes.then(() => writeFileDurable(durableWriteTempPath(path), path, payload))
    writes = write.catch(() => {})
    return write
  }
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PendingFile>
        deliveries = Array.isArray(parsed.deliveries) ? parsed.deliveries : []
      } catch {
        deliveries = []
      }
      return [...deliveries]
    },
    list: () => [...deliveries],
    get: (id) => deliveries.find((entry) => entry.id === id),
    async add(delivery) {
      if (
        deliveries.filter((entry) => entry.state === 'waiting').length >=
        SESSION_PENDING_MAX_WAITING
      ) {
        throw new Error(
          `${SESSION_PENDING_MAX_WAITING} prompts are already waiting for busy sessions; cancel some with omni session pending --cancel <id>.`
        )
      }
      deliveries = [...deliveries, delivery]
      try {
        await persist()
      } catch (error) {
        deliveries = deliveries.filter((entry) => entry.id !== delivery.id)
        throw error
      }
    },
    async update(id, patch) {
      const current = deliveries.find((entry) => entry.id === id)
      if (!current) {
        throw new Error(`No held prompt ${id}.`)
      }
      const next = { ...current, ...patch }
      deliveries = deliveries.map((entry) => (entry.id === id ? next : entry))
      try {
        await persist()
      } catch (error) {
        deliveries = deliveries.map((entry) => (entry.id === id ? current : entry))
        throw error
      }
      return next
    }
  }
}
