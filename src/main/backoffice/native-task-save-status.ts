import { watchNativeTaskSave } from './native-task-save-invalidation'
import type { AgentSessionTaskSave } from '../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { NativeJournalObservation } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { currentConsolePublicationScope } from './console-workflow-person'

const localWrites = new WeakMap<
  AgentSessionJournal,
  {
    taskId: string
    state: 'saving' | 'attention'
    token: symbol
  }
>()

export function reportNativeTaskSave(
  input: NativeJournalObservation,
  state: AgentSessionTaskSave['state']
): void {
  const taskId = input.record.hubTaskId
  if (!taskId || !input.isCurrent(taskId)) {
    return
  }
  const current = watchNativeTaskSave(input)
  input.onTaskSave?.({ taskId, state: current ? state : 'unavailable' })
}

export function recordNativeTaskSaveFailure(input: NativeJournalObservation): void {
  const taskId = input.record.hubTaskId
  if (taskId && input.isCurrent(taskId) && localWrites.get(input.journal)?.state !== 'saving') {
    localWrites.set(input.journal, { taskId, state: 'attention', token: Symbol() })
    reportNativeTaskSave(input, 'attention')
  }
}

export function beginNativeTaskRetention(
  input: NativeJournalObservation
): (saved: boolean) => void {
  const taskId = input.record.hubTaskId
  const token = Symbol()
  if (taskId && input.isCurrent(taskId)) {
    localWrites.set(input.journal, { taskId, state: 'saving', token })
    reportNativeTaskSave(input, 'saving')
  }
  return (saved) => {
    if (localWrites.get(input.journal)?.token !== token) {
      return
    }
    localWrites.delete(input.journal)
    if (saved) {
      publishNativeTaskSave(input)
    } else {
      recordNativeTaskSaveFailure(input)
    }
  }
}

export function publishNativeTaskSave(input: NativeJournalObservation): void {
  const local = localWrites.get(input.journal)
  if (local && local.taskId === input.record.hubTaskId) {
    reportNativeTaskSave(input, local.state)
    return
  }
  const scope = currentConsolePublicationScope()
  const rows = input.journal
    .taskPublications()
    .filter((row) => row.taskId === input.record.hubTaskId)
  if (
    !scope?.profileKey ||
    !rows.length ||
    rows.some(
      (row) =>
        row.principal !== scope.principal ||
        row.baseUrl !== scope.baseUrl ||
        row.profileKey !== scope.profileKey
    )
  ) {
    reportNativeTaskSave(input, 'unavailable')
    return
  }
  reportNativeTaskSave(input, rows.some((row) => row.noteId === null) ? 'pending' : 'shared')
}
