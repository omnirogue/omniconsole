import type { LocalRunDraft } from '../../../shared/local-run-graph'
import { normalizeLocalRunDraft } from '../../../shared/local-run-graph'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type LocalRunDraftRuntime = Pick<StoreRuntimeState, 'state'>

const localRunDraftPersistenceContext = Symbol('LocalRunDraftPersistence')
type LocalRunDraftPersistenceContext = {
  runtime: LocalRunDraftRuntime
  scheduling: WriteSchedulingOperations
}

/**
 * Saved local-run graphs live in the profile state file beside automations and
 * session chains. They are definitions a person keeps, never a queue and never a
 * record of anyone else's work.
 */
export class LocalRunDraftPersistence {
  readonly [localRunDraftPersistenceContext]: LocalRunDraftPersistenceContext

  constructor(runtime: LocalRunDraftRuntime, scheduling: WriteSchedulingOperations) {
    this[localRunDraftPersistenceContext] = { runtime, scheduling }
  }

  listLocalRunDrafts(): LocalRunDraft[] {
    return [...(this[localRunDraftPersistenceContext].runtime.state.localRunDrafts ?? [])]
  }

  upsertLocalRunDraft(input: unknown): LocalRunDraft {
    const now = Date.now()
    const draft = normalizeLocalRunDraft({
      createdAt: now,
      ...(input && typeof input === 'object' ? input : {})
    })
    if (!draft) {
      throw new Error('A local run draft needs an id and a finite graph with a workspace path.')
    }
    const context = this[localRunDraftPersistenceContext]
    const current = context.runtime.state.localRunDrafts ?? []
    const existing = current.find((entry) => entry.id === draft.id)
    const stamped = { ...draft, createdAt: existing?.createdAt ?? draft.createdAt, updatedAt: now }
    context.runtime.state.localRunDrafts = existing
      ? current.map((entry) => (entry.id === draft.id ? stamped : entry))
      : [...current, stamped]
    scheduleSave(context.scheduling)
    return stamped
  }

  removeLocalRunDraft(id: string): boolean {
    const context = this[localRunDraftPersistenceContext]
    const current = context.runtime.state.localRunDrafts ?? []
    const next = current.filter((entry) => entry.id !== id)
    if (next.length === current.length) {
      return false
    }
    context.runtime.state.localRunDrafts = next
    scheduleSave(context.scheduling)
    return true
  }
}

export function installLocalRunDraftPersistenceContext(
  target: object,
  source: LocalRunDraftPersistence
): void {
  Object.defineProperty(target, localRunDraftPersistenceContext, {
    value: source[localRunDraftPersistenceContext]
  })
}
