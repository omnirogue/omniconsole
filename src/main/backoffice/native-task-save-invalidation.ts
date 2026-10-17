import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { NativeJournalObservation } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { subscribeCloudSessionMutations } from '../omni-profiles/profile-cloud-session-mutation'
import { subscribeBackofficeConnectionChanges } from './backoffice-config'

/** The host owns journals; retaining a status observer must not keep a closed session alive. */
export function createNativeTaskSaveInvalidation() {
  let generation = 0
  const inputGenerations = new WeakMap<NativeJournalObservation, number>()
  const observations = new WeakMap<AgentSessionJournal, NativeJournalObservation>()
  const journals = new Set<WeakRef<AgentSessionJournal>>()
  return {
    watch(input: NativeJournalObservation): boolean {
      const captured = inputGenerations.get(input)
      if (captured !== undefined && captured !== generation) {
        return false
      }
      inputGenerations.set(input, generation)
      if (!input.onTaskSave) {
        return true
      }
      if (!observations.has(input.journal)) {
        journals.add(new WeakRef(input.journal))
      }
      observations.set(input.journal, input)
      return true
    },
    invalidate(): void {
      generation += 1
      for (const reference of journals) {
        const journal = reference.deref()
        const input = journal && observations.get(journal)
        const taskId = input?.record.hubTaskId
        if (!input || !taskId || !input.isCurrent(taskId)) {
          journals.delete(reference)
          if (journal) {
            observations.delete(journal)
          }
          continue
        }
        try {
          input.onTaskSave?.({ taskId, state: 'unavailable' })
        } catch {
          // One disconnected view must not retain another view's old confirmation.
        }
      }
    }
  }
}

const invalidation = createNativeTaskSaveInvalidation()
subscribeCloudSessionMutations(invalidation.invalidate)
subscribeBackofficeConnectionChanges(invalidation.invalidate)
export const watchNativeTaskSave = invalidation.watch
