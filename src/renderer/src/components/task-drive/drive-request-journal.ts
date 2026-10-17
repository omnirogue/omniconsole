import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import {
  consoleDriveFileRequest,
  type ConsoleDriveIntake
} from '../../../../shared/console-drive-contract'

const entrySchema = z.object({
  phase: z.enum(['pending', 'uncertain']),
  input: consoleDriveFileRequest.nullable(),
  beforeIds: z.array(z.string())
})
export type DriveRequestEntry = z.infer<typeof entrySchema>
const entries = new Map<string, DriveRequestEntry | null>()
const listeners = new Set<() => void>()
const storageKey = (scope: string) => `omni-drive-request:${scope}`

export function subscribeDriveRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readDriveRequest(scope: string): DriveRequestEntry | null {
  if (!entries.has(scope)) {
    try {
      const raw = sessionStorage.getItem(storageKey(scope))
      const entry = raw ? entrySchema.parse(JSON.parse(raw)) : null
      entries.set(scope, entry ? { ...entry, phase: 'uncertain' } : null)
    } catch {
      entries.set(scope, { phase: 'uncertain', input: null, beforeIds: [] })
    }
  }
  return entries.get(scope) ?? null
}

export function rememberDriveRequest(scope: string, entry: DriveRequestEntry | null): void {
  try {
    if (entry) {
      sessionStorage.setItem(storageKey(scope), JSON.stringify(entry))
    } else {
      sessionStorage.removeItem(storageKey(scope))
    }
  } catch {
    const previous = entry ?? entries.get(scope)
    entries.set(scope, {
      input: previous?.input ?? null,
      beforeIds: previous?.beforeIds ?? [],
      phase: 'uncertain'
    })
    for (const listener of listeners) {
      listener()
    }
    throw new Error(
      translate(
        'drive.requestStorageUnavailable',
        'The file request status could not be saved on this computer. Refresh to check recorded requests.'
      )
    )
  }
  entries.set(scope, entry)
  for (const listener of listeners) {
    listener()
  }
}

export function matchingDriveRequests(entry: DriveRequestEntry, rows: ConsoleDriveIntake[]) {
  const input = entry.input
  if (!input) {
    return []
  }
  return rows.filter(
    (row) =>
      !entry.beforeIds.includes(row.id) &&
      row.task_id === input.taskId &&
      row.expected_from === input.expected_from &&
      row.pattern === input.pattern &&
      row.expected_count === (input.expected_count ?? null)
  )
}
