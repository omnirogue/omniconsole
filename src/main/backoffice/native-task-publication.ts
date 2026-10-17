import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { JournalTaskPublication } from '../native-chat/agent-session-journal/journal-task-publication'
import {
  buildBackofficeExecutionNote,
  postSavedBackofficeExecutionNote,
  type BackofficeExecutionObservation,
  type BackofficePublicationScope
} from './backoffice-execution-observation'
import { sanitizeConsoleWorkflowText } from './console-workflow-person'

export async function retainNativeTaskObservation(
  journal: AgentSessionJournal,
  observation: BackofficeExecutionObservation,
  scope: BackofficePublicationScope,
  fence: number
): Promise<void> {
  if (!scope.profileKey) {
    throw new Error('A native task save requires its original IDE profile.')
  }
  const body = buildBackofficeExecutionNote(observation)
  const request = JSON.stringify(body)
  if (sanitizeConsoleWorkflowText(request) !== request || scope.isCurrent?.() === false) {
    throw new Error('The task note cannot be retained under the current account and task binding.')
  }
  const previous = journal.taskPublications()
  if (
    previous.some(
      (row) =>
        row.principal !== scope.principal ||
        row.baseUrl !== scope.baseUrl ||
        row.profileKey !== scope.profileKey
    )
  ) {
    throw new Error('The session journal belongs to another account or connection.')
  }
  const saved = previous.find((row) => row.sourceEventId === body.source_event_id)
  const entry: JournalTaskPublication = {
    sourceEventId: body.source_event_id,
    taskId: observation.hubTaskId,
    principal: scope.principal,
    profileKey: scope.profileKey,
    baseUrl: scope.baseUrl,
    request,
    noteId: saved?.noteId ?? null
  }
  await journal.saveTaskPublication(entry, fence)
}

const deliveries = new WeakMap<AgentSessionJournal, Promise<void>>()

/** Recover existing pending records; no new key or substitute task is minted here. */
export function recoverNativeTaskPublications(
  journal: AgentSessionJournal,
  fence: number,
  isCurrent: (taskId: string) => boolean
): Promise<void> {
  const existing = deliveries.get(journal)
  if (existing) {
    return existing
  }
  const run = (async () => {
    for (const row of journal
      .taskPublications()
      .filter((item) => item.noteId === null && isCurrent(item.taskId))
      .slice(0, 3)) {
      if (!isCurrent(row.taskId)) {
        return
      }
      // Repeat the persistence barrier, including after a previous ambiguous local write.
      await journal.saveTaskPublication(row, fence)
      const reply = await postSavedBackofficeExecutionNote(row, () => isCurrent(row.taskId))
      if (!reply.ok || !isCurrent(row.taskId)) {
        return
      }
      await journal.saveTaskPublication({ ...row, noteId: reply.noteId }, fence)
    }
  })().finally(() => {
    deliveries.delete(journal)
  })
  deliveries.set(journal, run)
  return run
}
