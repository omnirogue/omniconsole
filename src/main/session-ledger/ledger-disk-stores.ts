import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { CoalescedWrite, type CoalescedWriteTiming } from '../coalesced-state-write'
import type { LedgerSpillStore } from './ledger-event-queue'
import { parsePersistedPanes, type LedgerPaneStore } from './ledger-identity'

export const LEDGER_QUEUE_FILE_NAME = 'session-ledger-queue.json'

export function sessionLedgerStores(
  userDataPath: string,
  overrides: { paneStore?: LedgerPaneStore | null; spillStore?: LedgerSpillStore | null }
): { paneStore: LedgerPaneStore | null; spillStore: LedgerSpillStore | null } {
  return {
    paneStore:
      overrides.paneStore === undefined
        ? paneFileStore(join(userDataPath, 'session-ledger-panes.json'))
        : overrides.paneStore,
    spillStore:
      overrides.spillStore === undefined
        ? jsonFileStore(join(userDataPath, LEDGER_QUEUE_FILE_NAME))
        : overrides.spillStore
  }
}

/**
 * A JSON file store. A truncated or non-JSON file is set aside as `<path>.<reason>-<ts>` and
 * read as absent, so one bad write cannot wedge every later start; an I/O failure propagates
 * to the caller, which treats the file as unavailable. Writes are atomic (temp file + rename).
 */
export function jsonFileStore(path: string): LedgerSpillStore {
  // Why: a rename only — a file that cannot be set aside is never deleted (it may hold real batches).
  const quarantine = (reason: string): void => {
    if (existsSync(path)) {
      renameSync(path, `${path}.${reason}-${Date.now()}`)
    }
  }
  return {
    read: () => {
      if (!existsSync(path)) {
        return null
      }
      const text = readFileSync(path, 'utf8')
      try {
        return JSON.parse(text)
      } catch {
        quarantine('corrupt')
        return null
      }
    },
    write: (value) => writeSecureJsonFile(path, value),
    remove: () => {
      if (existsSync(path)) {
        unlinkSync(path)
      }
    },
    quarantine
  }
}

// Why: hook events re-save the registry many times a minute, mostly with unchanged content (#857).
export const PANE_STORE_WRITE_TIMING: CoalescedWriteTiming = {
  debounceMs: 1_000,
  maxWaitMs: 5_000,
  burst: 3,
  refillMs: 10_000
}

// Why module-level: the quit path flushes whatever the registry last saved without owning the store.
const livePaneWriters = new Set<CoalescedWrite>()

/** Write any coalesced pane-registry save now (quit). */
export function flushLedgerPaneStores(): void {
  for (const writer of livePaneWriters) {
    writer.flush()
  }
}

export function paneFileStore(
  path: string,
  timing: CoalescedWriteTiming = PANE_STORE_WRITE_TIMING
): LedgerPaneStore {
  const file = jsonFileStore(path)
  let lastWritten: string | null = null
  let next: string | null = null
  const writer = new CoalescedWrite(timing, () => {
    const contents = next
    next = null
    if (contents === null || contents === lastWritten) {
      return
    }
    try {
      writeSecureFile(path, contents)
      lastWritten = contents
    } catch {
      // Why: the registry is a convenience across restarts; a failed save costs one resume link.
    }
  })
  livePaneWriters.add(writer)
  return {
    load: () => {
      try {
        const value = file.read() as { panes?: unknown } | null
        lastWritten = value === null ? null : JSON.stringify(value, null, 2)
        return parsePersistedPanes(value?.panes)
      } catch {
        return []
      }
    },
    save: (entries) => {
      const contents = JSON.stringify({ version: 1, panes: entries }, null, 2)
      if (contents === lastWritten) {
        next = null
        writer.cancel()
        return
      }
      next = contents
      writer.schedule()
    }
  }
}
