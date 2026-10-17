/**
 * Starts this computer's host organization service and its steward (`t`) account sync in the
 * main process, so a runtime with no window still publishes what it committed and still hears
 * other computers' revocations. Signed out, a pass does nothing; the outbox keeps its entries.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAccountSyncPrefs, writeAccountSyncPref } from '../backoffice/backoffice-account-sync'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'
import {
  bindSessionOrganizationHostWindow,
  sessionOrganizationHostFor,
  type HostOrganizationWindowBinding
} from './host-organization-instance'
import { ORGANIZATION_HISTORY_DIRECTORY } from './organization-history-store'
import type { HostSyncIngest } from '../../shared/session-organization-host-sync'
import {
  createStewardSync,
  type StewardSyncPass,
  type StewardSyncState
} from '../../shared/steward-account-sync'

export const STEWARD_SYNC_STATE_FILE = 'steward-sync.json'
const FIRST_PASS_MS = 15_000
const PASS_EVERY_MS = 5 * 60_000
const AFTER_CHANGE_MS = 5_000
const DEVICE = /^[0-9a-f]{8}$/

type Running = { runSoon: (timeoutMs: number) => Promise<StewardSyncPass | null> }
const running = new Map<string, Running>()

function stateStore(directory: string) {
  const path = join(directory, STEWARD_SYNC_STATE_FILE)
  let states: Record<string, StewardSyncState> = {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<StewardSyncState>>
    states = Object.fromEntries(
      Object.entries(raw).flatMap(([user, state]) =>
        typeof state?.device === 'string' && DEVICE.test(state.device)
          ? [
              [
                user,
                { device: state.device, docs: typeof state.docs === 'number' ? state.docs : 1 }
              ]
            ]
          : []
      )
    )
  } catch {
    // A new device id is harmless: the old one's documents stay readable to every computer.
  }
  return {
    load: (user: string) => states[user] ?? null,
    save: (user: string, state: StewardSyncState) => {
      states = { ...states, [user]: state }
      const json = JSON.stringify(states)
      void mkdir(directory, { recursive: true })
        .then(() => writeFileDurable(durableWriteTempPath(path), path, json))
        .catch((error: unknown) => {
          console.warn('[session-organization] saving the steward sync state failed', error)
        })
    }
  }
}

/** Runs a steward sync pass now, bounded; null when none is running or it did not finish in time. */
export async function runStewardSyncSoon(
  userDataPath: string,
  timeoutMs: number
): Promise<StewardSyncPass | null> {
  return (await running.get(userDataPath)?.runSoon(timeoutMs)) ?? null
}

type SyncEntriesListener = (entries: HostSyncIngest['entries']) => void
const entriesListeners = new Set<SyncEntriesListener>()

/** Hears every other computer's `t` entries after each pass (policy overrides, Phase 4 E). */
export function onStewardSyncEntries(listener: SyncEntriesListener): () => void {
  entriesListeners.add(listener)
  return () => {
    entriesListeners.delete(listener)
  }
}

/** Returns the stop, which also flushes the host's values and outbox. */
export function startSessionOrganizationHost(
  userDataPath: string,
  window: HostOrganizationWindowBinding
): () => Promise<void> {
  bindSessionOrganizationHostWindow(userDataPath, window)
  const host = sessionOrganizationHostFor(userDataPath)
  const sync = createStewardSync({
    read: readAccountSyncPrefs,
    write: writeAccountSyncPref,
    outbox: host.outbox,
    state: stateStore(join(userDataPath, ORGANIZATION_HISTORY_DIRECTORY)),
    newDevice: () => randomBytes(4).toString('hex'),
    ingest: (input) => {
      for (const listener of entriesListeners) {
        try {
          listener(input.entries)
        } catch (error) {
          console.warn('[session-organization] a steward sync listener failed', error)
        }
      }
      return host.ingest({ ...input, headless: !(window.windowAttached?.() ?? false) })
    }
  })
  const run = (): Promise<StewardSyncPass | null> =>
    sync.run().catch((error: unknown) => {
      console.warn('[session-organization] steward sync pass failed', error)
      return null
    })
  let soon: ReturnType<typeof setTimeout> | undefined
  const stopQueued = host.outbox.onQueued(() => {
    clearTimeout(soon)
    soon = setTimeout(() => void run(), AFTER_CHANGE_MS)
  })
  const first = setTimeout(() => void run(), FIRST_PASS_MS)
  const interval = setInterval(() => void run(), PASS_EVERY_MS)
  running.set(userDataPath, {
    runSoon: (timeoutMs) =>
      Promise.race([
        run(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeoutMs).unref?.()
        })
      ])
  })
  return async () => {
    running.delete(userDataPath)
    stopQueued()
    clearTimeout(soon)
    clearTimeout(first)
    clearInterval(interval)
    await host.flush()
  }
}
