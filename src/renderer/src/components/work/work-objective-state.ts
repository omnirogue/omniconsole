import type { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { readWorkObjectiveStorage, writeWorkObjectiveStorage } from './work-objective-storage'
import type {
  SESSION_PREP_PARAMS,
  SessionPrepRequestResult
} from '../../../../shared/session-prep-types'

type ObjectiveRequest = z.infer<typeof SESSION_PREP_PARAMS.request>
export type WorkObjective = {
  id: string
  text: string
  request?: ObjectiveRequest
  batchId?: string
  error?: string
}
export type WorkObjectives = { rows: WorkObjective[]; sending: boolean; storageError?: string }
const drafts = new Map<string, WorkObjectives>()
const listeners = new Set<() => void>()

export const newWorkObjective = (): WorkObjective => ({ id: crypto.randomUUID(), text: '' })

export function workObjectives(paneKey: string): WorkObjectives {
  let value = drafts.get(paneKey)
  if (!value) {
    try {
      value = readWorkObjectiveStorage(paneKey)
      if (value) {
        value.rows = value.rows.map((row) =>
          row.request && !row.batchId && !row.error
            ? {
                ...row,
                error: translate(
                  'needSpeed.interrupted',
                  'Submission was interrupted. Retry to check whether this prompt was accepted.'
                )
              }
            : row
        )
      }
    } catch {
      value = {
        rows: [newWorkObjective()],
        sending: false,
        storageError: translate(
          'needSpeed.restoreFailed',
          'Saved prompts could not be restored. Check existing work before submitting again.'
        )
      }
    }
    value ??= { rows: [newWorkObjective()], sending: false }
    drafts.set(paneKey, value)
  }
  return value
}

export function updateWorkObjectives(
  paneKey: string,
  update: (value: WorkObjectives) => WorkObjectives
): boolean {
  const value = update(workObjectives(paneKey))
  let saved = true
  try {
    writeWorkObjectiveStorage(paneKey, value)
    value.storageError = undefined
  } catch {
    saved = false
    value.storageError = translate(
      'needSpeed.saveFailed',
      'Could not save these prompts. New submissions are paused until saving works.'
    )
  }
  drafts.set(paneKey, value)
  for (const listener of listeners) {
    listener()
  }
  return saved
}

export function subscribeWorkObjectives(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The request is frozen before sending; a lost reply can only retry that same objective. */
export async function submitWorkObjectives(
  paneKey: string,
  prepare: (row: WorkObjective) => Promise<ObjectiveRequest>,
  dispatch: (request: ObjectiveRequest) => Promise<SessionPrepRequestResult>
): Promise<void> {
  const current = workObjectives(paneKey)
  if (current.sending) {
    return
  }
  if (!updateWorkObjectives(paneKey, (state) => ({ ...state, sending: true }))) {
    updateWorkObjectives(paneKey, (state) => ({ ...state, sending: false }))
    return
  }
  const updateRow = (id: string, update: Partial<WorkObjective>) =>
    updateWorkObjectives(paneKey, (state) => ({
      ...state,
      rows: state.rows.map((row) => (row.id === id ? { ...row, ...update } : row))
    }))
  try {
    const pending = current.rows.filter((row) => !row.batchId && row.text.trim())
    const submitNext = async () => {
      for (let row = pending.shift(); row; row = pending.shift()) {
        try {
          const request = row.request ?? (await prepare(row))
          if (!updateRow(row.id, { request, error: undefined })) {
            continue
          }
          // The frozen request is durable before the first attempt, including its mode.
          const accepted = await dispatch(request)
          updateRow(row.id, { batchId: accepted.batchId })
        } catch (error) {
          updateRow(row.id, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    // Bound renderer RPCs too; the service still owns its shared preparation cap.
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, submitNext))
  } finally {
    updateWorkObjectives(paneKey, (state) => ({ ...state, sending: false }))
  }
}
