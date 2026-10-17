import { sessionOutcomeStepSignature } from '../../runtime/session-outcome-revision'
import type { SessionChain } from '../../../shared/session-chain-types'
import { normalizeSessionChain } from '../../../shared/session-chain-types'
import { validateSessionOutcomeDefinitions } from '../../../shared/session-outcome-state'
import { sessionOutcomeDefinition } from '../../../shared/session-outcome-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type SessionChainRuntime = Pick<StoreRuntimeState, 'state'> &
  Partial<Pick<StoreRuntimeState, 'flushOrThrow' | 'writesFrozen'>>

const sessionChainPersistenceContext = Symbol('SessionChainPersistence')
type SessionChainPersistenceContext = {
  runtime: SessionChainRuntime
  scheduling: WriteSchedulingOperations
  snapshot?: { source: SessionChain[] | undefined; chains: SessionChain[] }
}

// Why frozen: a reader that changed the shared snapshot would silently corrupt every later reader.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}

/** Session chains live in the profile state file beside automations; the renderer reads and writes them over RPC. */
export class SessionChainPersistence {
  readonly [sessionChainPersistenceContext]: SessionChainPersistenceContext

  constructor(runtime: SessionChainRuntime, scheduling: WriteSchedulingOperations) {
    this[sessionChainPersistenceContext] = { runtime, scheduling }
  }

  /** A deep-frozen snapshot shared by every reader until the next write; copy before changing. */
  listSessionChains(): SessionChain[] {
    const context = this[sessionChainPersistenceContext]
    const source = context.runtime.state.sessionChains
    // Why identity: every writer replaces the array, so the same array means the same chains.
    if (!context.snapshot || context.snapshot.source !== source) {
      context.snapshot = { source, chains: deepFreeze(structuredClone(source ?? [])) }
    }
    return context.snapshot.chains
  }

  upsertSessionChain(input: unknown): SessionChain {
    const chain = normalizeSessionChain(input)
    if (!chain) {
      throw new Error(
        'A session chain needs an id, a workspace, a source pane and at least one step, unless it only ends the session.'
      )
    }
    const context = this[sessionChainPersistenceContext]
    const current = context.runtime.state.sessionChains ?? []
    const existing = current.find((entry) => entry.id === chain.id)
    if (chain.outcomeSet || existing?.outcomeSet) {
      throw new Error('Committed outcomes require the atomic outcome API; update this client.')
    }
    // Why: the quarantined record is the only copy of a plan this build could not read. Overwriting
    // it with a client's view of the same id would delete the work it is holding.
    if (chain.quarantine || existing?.quarantine) {
      throw new Error('This plan could not be read by this OmniConsole; it cannot be overwritten.')
    }
    if (!existing) {
      throw new Error('legacy_renderer_chain_creation_refused: Use the atomic outcome API.')
    }
    if (
      chain.steps.length !== existing.steps.length ||
      chain.steps.some(
        (step, index) =>
          step.id !== existing.steps[index]!.id ||
          sessionOutcomeStepSignature(step) !== sessionOutcomeStepSignature(existing.steps[index]!)
      ) ||
      (
        [
          'workspacePath',
          'worktreeId',
          'hostId',
          'sourcePaneKey',
          'sourceRowKey',
          'end',
          'placement'
        ] as const
      ).some((key) => chain[key] !== existing[key])
    ) {
      throw new Error(
        'legacy_renderer_chain_creation_refused: Persisted plans only accept progress updates.'
      )
    }
    const stamped = { ...chain, updatedAt: Date.now() }
    const index = current.findIndex((entry) => entry.id === chain.id)
    context.runtime.state.sessionChains =
      index === -1
        ? [...current, stamped]
        : current.map((entry, position) => (position === index ? stamped : entry))
    scheduleSave(context.scheduling)
    return stamped
  }

  replaceSessionChainOutcomesAndFlush(input: SessionChain, expectedRevision: number): SessionChain {
    const context = this[sessionChainPersistenceContext]
    if (!context.runtime.flushOrThrow || context.runtime.writesFrozen) {
      throw new Error('Durable outcome persistence is unavailable on this host.')
    }
    const chain = normalizeSessionChain(input)
    if (!chain?.outcomeSet) {
      throw new Error('Invalid committed outcome set.')
    }
    const previous = context.runtime.state.sessionChains ?? []
    const existing = previous.find((entry) => entry.id === chain.id)
    if (existing?.quarantine) {
      throw new Error('This plan could not be read by this OmniConsole; it cannot be overwritten.')
    }
    if ((existing?.outcomeSet?.revision ?? 0) !== expectedRevision) {
      throw new Error('Outcome revision conflict. Reload the saved outcomes.')
    }
    // Why here as well as in the service: this is the one durable door, and card filing and a
    // stale snapshot both reach it without the service. A sealed run keeps its seal and its state.
    const seal = existing?.outcomeSet?.completion
    if (
      seal &&
      (JSON.stringify(chain.outcomeSet.completion) !== JSON.stringify(seal) ||
        (existing.state === 'done' && chain.state !== 'done'))
    ) {
      throw new Error('This run is sealed as completed; new work starts a new run.')
    }
    // Why: main is the authority on plan size, and this is the write every commit must pass through.
    // Only an authoring change is measured: a progress save of a plan committed before these caps
    // existed must keep running, and a cap is never a reason to stop recording what already ran.
    if (chain.outcomeSet.revision > (existing?.outcomeSet?.revision ?? 0)) {
      validateSessionOutcomeDefinitions(
        // Why mapped: the schema is strict, and a committed outcome carries its revision, status and
        // evidence beside its definition.
        chain.outcomeSet.outcomes.map(sessionOutcomeDefinition),
        { steps: chain.steps }
      )
    }
    const stamped = { ...chain, updatedAt: Date.now() }
    context.runtime.state.sessionChains = existing
      ? previous.map((entry) => (entry.id === chain.id ? stamped : entry))
      : [...previous, stamped]
    try {
      context.runtime.flushOrThrow()
    } catch (error) {
      context.runtime.state.sessionChains = previous
      throw error
    }
    return structuredClone(stamped)
  }

  removeSessionChain(id: string): boolean {
    const context = this[sessionChainPersistenceContext]
    const current = context.runtime.state.sessionChains ?? []
    if (current.find((entry) => entry.id === id)?.outcomeSet) {
      throw new Error(
        'Committed outcomes must be explicitly revised; they cannot be removed by a legacy client.'
      )
    }
    const next = current.filter((entry) => entry.id !== id)
    if (next.length === current.length) {
      return false
    }
    context.runtime.state.sessionChains = next
    scheduleSave(context.scheduling)
    return true
  }
}

export function installSessionChainPersistenceContext(
  target: object,
  source: SessionChainPersistence
): void {
  Object.defineProperty(target, sessionChainPersistenceContext, {
    value: source[sessionChainPersistenceContext]
  })
}
