import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'
import {
  encodeGridDocument,
  gridDowngradeSnapshot,
  readGridDocument,
  readGridNotes,
  readGridSnapshot,
  type SessionGridDocument,
  type SessionGridStorageStatus
} from '@/lib/session-grid-document'
import type { SessionGridSnapshot } from '@/lib/session-grid-panes'
import { gridDocumentNotes, reconcileLegacyGrid } from '@/lib/session-grid-legacy-reconciliation'
import { applyGridTemplate } from '@/lib/session-grid-templates'

export const SESSION_GRID_V2_STORAGE_KEY = 'omni.session-grid.v2'
export const SESSION_GRID_NOTES_STORAGE_KEY = 'omni.session-grid.notes.v1'
export const SESSION_GRID_V1_STORAGE_KEY = 'omni.session-grid.v1'
export const SESSION_GRID_MIRROR_STORAGE_KEY = 'omni.session-grid.legacy-mirror.v1'

export function gridDocument(snapshot: SessionGridSnapshot, name = 'Default'): SessionGridDocument {
  return { version: 2, activeLayoutId: 'default', layouts: [{ id: 'default', name, snapshot }] }
}

function parseStored(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function loadGridDocument(
  empty: SessionGridSnapshot,
  pending?: SessionGridDocument | null
): {
  document: SessionGridDocument
  status: SessionGridStorageStatus
  blocked: boolean
} {
  let status: SessionGridStorageStatus = 'corrupt'
  let readFailed = false
  const read = (key: string): string | null => {
    try {
      return readPersonalView(localStorage, key)
    } catch (error) {
      readFailed = true
      throw error
    }
  }
  try {
    const raw = read(SESSION_GRID_V2_STORAGE_KEY)
    const legacy = read(SESSION_GRID_V1_STORAGE_KEY)
    const legacySnapshot = legacy === null ? null : readGridSnapshot(JSON.parse(legacy))
    if (legacy !== null && !legacySnapshot) {
      return { document: gridDocument(empty), status, blocked: true }
    }
    let document: SessionGridDocument
    if (raw !== null) {
      const result = readGridDocument(JSON.parse(raw))
      status = result.status
      if (!result.document) {
        return { document: gridDocument(empty), status, blocked: true }
      }
      document = result.document
    } else if (legacy !== null) {
      document = gridDocument(legacySnapshot!, 'Imported grid')
      status = 'healthy'
    } else {
      document = gridDocument(applyGridTemplate(empty, 'Default'))
      status = 'absent'
    }
    const notesRaw = read(SESSION_GRID_NOTES_STORAGE_KEY)
    const notes = notesRaw === null ? {} : readGridNotes(JSON.parse(notesRaw))
    if (!notes) {
      return { document: gridDocument(empty), status: 'corrupt', blocked: true }
    }
    document.layouts = document.layouts.map((entry) => ({
      ...entry,
      snapshot: {
        ...entry.snapshot,
        notes:
          raw === null
            ? { ...notes, ...entry.snapshot.notes }
            : { ...entry.snapshot.notes, ...notes }
      }
    }))
    if (pending) {
      document = pending
      status = 'unwritable'
    }
    if (raw !== null && !pending && legacySnapshot) {
      document = reconcileLegacyGrid(
        document,
        legacySnapshot,
        legacy!,
        read(SESSION_GRID_MIRROR_STORAGE_KEY)
      )
    }
    return { document, status, blocked: false }
  } catch {
    return {
      document: gridDocument(empty),
      status: readFailed ? 'unwritable' : 'corrupt',
      blocked: true
    }
  }
}

export function createGridWriter(onStatus: (status: SessionGridStorageStatus) => void): {
  schedule: (document: SessionGridDocument, notesOnly?: boolean) => void
  flush: () => void
  readPending: (scope: string) => SessionGridDocument | null
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  type Write = {
    document: SessionGridDocument
    scope: string
    notesOnly: boolean
    legacyRevision?: string | null
  }
  let pending: Write | null = null
  const failed = new Map<string, Write>()
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = null
    const writes = new Map(failed)
    if (pending) {
      writes.set(pending.scope, pending)
    }
    pending = null
    if (writes.size === 0) {
      return
    }
    let blockedStatus: 'corrupt' | 'unsupported' | null = null
    for (const write of writes.values()) {
      let { document, notesOnly } = write
      const { scope } = write
      try {
        const legacyKey = scope.replace(SESSION_GRID_V2_STORAGE_KEY, SESSION_GRID_V1_STORAGE_KEY)
        const mirrorKey = scope.replace(
          SESSION_GRID_V2_STORAGE_KEY,
          SESSION_GRID_MIRROR_STORAGE_KEY
        )
        const legacy = localStorage.getItem(legacyKey)
        const mirrored = localStorage.getItem(mirrorKey)
        const storedDocument = localStorage.getItem(scope)
        const notesKey = scope.replace(SESSION_GRID_V2_STORAGE_KEY, SESSION_GRID_NOTES_STORAGE_KEY)
        const storedNotes = localStorage.getItem(notesKey)
        const documentStatus =
          storedDocument === null ? 'healthy' : readGridDocument(parseStored(storedDocument)).status
        if (
          documentStatus !== 'healthy' ||
          (storedNotes !== null && !readGridNotes(parseStored(storedNotes)))
        ) {
          blockedStatus = documentStatus === 'unsupported' ? 'unsupported' : 'corrupt'
          failed.set(scope, write)
          continue
        }
        if (legacy !== null) {
          const snapshot = readGridSnapshot(parseStored(legacy))
          if (!snapshot) {
            blockedStatus = 'corrupt'
            failed.set(scope, write)
            continue
          }
          const baseline = write.legacyRevision === undefined ? mirrored : write.legacyRevision
          if (baseline !== undefined && legacy !== baseline) {
            document = reconcileLegacyGrid(document, snapshot, legacy, baseline)
            notesOnly = false
          }
        }
        const notes = gridDocumentNotes(document)
        const active = document.layouts.find((entry) => entry.id === document.activeLayoutId)!
        const rollback = JSON.stringify(gridDowngradeSnapshot({ ...active.snapshot, notes }))
        localStorage.setItem(notesKey, JSON.stringify(notes))
        if (!notesOnly) {
          localStorage.setItem(scope, JSON.stringify(encodeGridDocument(document)))
        }
        localStorage.setItem(legacyKey, rollback)
        // A failed mirror update leaves v1 divergent, so the next read imports it conservatively.
        localStorage.setItem(mirrorKey, rollback)
        failed.delete(scope)
      } catch {
        failed.set(scope, { ...write, document, notesOnly })
      }
    }
    onStatus(blockedStatus ?? (failed.size > 0 ? 'unwritable' : 'healthy'))
  }

  return {
    flush,
    readPending: (scope) => {
      const write = pending?.scope === scope ? pending : failed.get(scope)
      if (!write) {
        return null
      }
      try {
        const legacy = localStorage.getItem(
          scope.replace(SESSION_GRID_V2_STORAGE_KEY, SESSION_GRID_V1_STORAGE_KEY)
        )
        if (
          legacy !== null &&
          write.legacyRevision !== undefined &&
          legacy !== write.legacyRevision
        ) {
          const snapshot = readGridSnapshot(JSON.parse(legacy))
          if (snapshot) {
            return reconcileLegacyGrid(write.document, snapshot, legacy, write.legacyRevision)
          }
        }
      } catch {
        // The loader still validates all stored bytes before accepting a pending projection.
      }
      return write.document
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = null
      pending = null
      failed.clear()
    },
    schedule: (document, notesOnly = false) => {
      const scope = personalViewStorageKey(SESSION_GRID_V2_STORAGE_KEY)
      // Flush the captured owner before replacing it; never write one profile into another.
      if (pending && pending.scope !== scope) {
        flush()
      }
      const needsDocument =
        pending?.notesOnly === false || failed.get(scope)?.notesOnly === false || !notesOnly
      const previous = pending?.scope === scope ? pending : failed.get(scope)
      let legacyRevision = previous?.legacyRevision
      if (!previous) {
        try {
          legacyRevision = localStorage.getItem(
            scope.replace(SESSION_GRID_V2_STORAGE_KEY, SESSION_GRID_V1_STORAGE_KEY)
          )
        } catch {
          // A fresh read at flush remains mandatory when storage was unavailable here.
        }
      }
      pending = { document, scope, notesOnly: !needsDocument, legacyRevision }
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(flush, 300)
    }
  }
}
