import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
/** OmniConsole: the legacy turn-lifecycle row is the durable turn boundary. */
export function isTurnLifecycleIdentity(
  identity: JournalLifecycleMutationInput['identity']
): boolean {
  return identity.provider === 'legacy' && identity.recordId.startsWith('turn-lifecycle:')
}

export function endsTurnLifecycle(mutations: readonly JournalLifecycleMutationInput[]): boolean {
  return mutations.some(
    (mutation) => mutation.kind === 'tombstone' && isTurnLifecycleIdentity(mutation.identity)
  )
}
