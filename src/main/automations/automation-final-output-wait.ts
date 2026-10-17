import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { ResolveAutomationFinalOutput } from './automation-output-provenance'

const PROOF_WAIT_MS = 1_000
const PROOF_POLL_DELAYS_MS = [25, 50, 100, 200, 400, 225] as const
const MAX_PENDING_PROOFS = 4

type ProofSource = { run: AutomationRun; fingerprint: string; owned: boolean }
export type AutomationFinalOutputPreparation = {
  ready: Promise<void>
  isCurrent: () => boolean
}

/** Stop may arrive before the provider flushes its final native transcript record. */
export function createAutomationFinalOutputWaiter(
  store: Pick<Store, 'listAutomations' | 'listAutomationRuns' | 'automationOwnerPrecondition'>,
  resolve: ResolveAutomationFinalOutput | undefined
) {
  const pending = new Map<string, AutomationFinalOutputPreparation>()
  const delays = new Set<() => void>()
  let disposed = false
  let generation = 0

  const source = (runId: string): ProofSource | null => {
    const run = store.listAutomationRuns().find((entry) => entry.id === runId)
    const automation = run && store.listAutomations().find((entry) => entry.id === run.automationId)
    if (!run || !automation?.structuredOutput) {
      return null
    }
    // Sibling run/usage writes touch history timestamps, not this run's definition or authority.
    const {
      lastRunAt: _lastRunAt,
      updatedAt: _updatedAt,
      nextRunAt: _nextRunAt,
      ...definition
    } = automation
    const owner = store.automationOwnerPrecondition(automation.id)
    return {
      run,
      fingerprint: JSON.stringify([definition, run, owner]),
      owned: owner?.selector.kind === 'self'
    }
  }

  const delay = (milliseconds: number): Promise<void> =>
    new Promise((complete) => {
      const finish = (): void => {
        clearTimeout(timer)
        delays.delete(finish)
        complete()
      }
      const timer = setTimeout(finish, milliseconds)
      timer.unref?.()
      delays.add(finish)
    })

  const prepare = (
    result: AutomationDispatchResult
  ): AutomationFinalOutputPreparation | undefined => {
    if (!resolve || result.status !== 'completed') {
      return undefined
    }
    const captured = source(result.runId)
    if (!captured || captured.run.outputSnapshot?.provenance === 'assistant_message') {
      return undefined
    }
    const existing = pending.get(result.runId)
    if (existing) {
      return existing
    }
    const capturedGeneration = generation
    const isCurrent = (): boolean => {
      try {
        return (
          !disposed &&
          generation === capturedGeneration &&
          captured.owned &&
          source(result.runId)?.fingerprint === captured.fingerprint
        )
      } catch {
        return false
      }
    }
    if (disposed || !captured.owned || pending.size >= MAX_PENDING_PROOFS) {
      return { ready: Promise.resolve(), isCurrent: () => false }
    }
    const startedAt = Date.now()
    const ready = (async (): Promise<void> => {
      for (let attempt = 0; attempt <= PROOF_POLL_DELAYS_MS.length; attempt += 1) {
        if (!isCurrent()) {
          return
        }
        try {
          if (resolve(captured.run, result)) {
            return
          }
        } catch {
          // A missing native proof never changes ordinary completion semantics.
        }
        const interval = PROOF_POLL_DELAYS_MS[attempt]
        const remaining = PROOF_WAIT_MS - (Date.now() - startedAt)
        if (interval === undefined || remaining <= 0) {
          return
        }
        await delay(Math.min(interval, remaining))
      }
    })()
    const preparation = { ready, isCurrent }
    pending.set(result.runId, preparation)
    void ready.finally(() => {
      if (pending.get(result.runId) === preparation) {
        pending.delete(result.runId)
      }
    })
    return preparation
  }

  return {
    prepare,
    resume(): void {
      disposed = false
    },
    dispose(): void {
      disposed = true
      generation += 1
      for (const finish of delays) {
        finish()
      }
      pending.clear()
    }
  }
}
