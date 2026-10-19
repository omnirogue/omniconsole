import { isSealedOutcomeChain } from './session-outcome-source-uniqueness'
import { attachSessionOutcomeTask, outcomeTaskAttachmentAccess } from './session-outcome-task-post'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import { commitSessionOutcomeSet } from './session-outcome-commit'
import { resumeSessionOutcomeWork } from './session-outcome-resume'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { reviewSessionOutcomeCondition } from './session-outcome-review'
import { chooseSessionOutcomeWait, type WaitChoiceInput } from './session-outcome-wait-choice'
import { randomUUID } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionRunDispositionReport } from '../../shared/session-run-completion'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import {
  announceSessionHumanAttention,
  type SessionAttentionAnnouncer
} from './session-outcome-attention-announce'
import { sameDurableSessionChain, settleSessionOutcomeChain } from './session-outcome-completion'
import {
  reportSessionOutcomeDisposition,
  retrySessionOutcomeDisposition
} from './session-outcome-disposition'
import {
  pendingSessionOutcomeChains,
  sessionOutcomeStateDisagrees,
  sessionOutcomeTickDuty,
  type SessionOutcomeReconcileReason
} from './session-outcome-reconcile'
import { verifySessionOutcomeOnRequest } from './session-outcome-verify-request'
import type { OrcaRuntimeService } from './omni-runtime'
import { advanceSessionOutcomes, installDeliverableRepairs } from './session-outcome-tick'
import {
  mergeSessionOutcomeAttempt,
  SessionOutcomeLaunches,
  type SessionOutcomeLaunchDetach
} from './session-outcome-launch-detach'
import { runSessionOutcomePreTickWork } from './session-outcome-pre-tick'
import { blockOutcomesForTickFailure } from './session-outcome-tick-failure'
import { upNextHeldContinuation } from './up-next-held-gates'
import { observeOrchestrationOutcomeChange } from '../structured-decisions/orchestration-shadow'
import { noteSessionOutcomeSaved } from './session-outcome-waits-listener'
import { acceptPersistedOutcomeWorkers } from './session-outcome-worker-acceptance'

export class SessionOutcomeService {
  readonly epoch = randomUUID()
  /** Launches this host is still waiting on; an attempt listed here is alive in this process. */
  readonly launches = new SessionOutcomeLaunches()
  private readonly pending = new Map<string, Promise<unknown>>()
  private suspended = false
  private timer: ReturnType<typeof setInterval> | null = null
  private reconciling: Promise<void> | null = null
  private reconcileAgain = false
  /** The host's clock: every seal, stamp and due time this service writes is read from it. */
  readonly now: () => number
  private readonly announce: SessionAttentionAnnouncer

  constructor(
    readonly runtime: OrcaRuntimeService,
    readonly taskAttachment = outcomeTaskAttachmentAccess,
    deps: { now?: () => number; announce?: SessionAttentionAnnouncer } = {}
  ) {
    // Why a call: a clock installed after construction (fake timers, a spy) must be the one read.
    this.now = deps.now ?? (() => Date.now())
    this.announce = deps.announce ?? announceSessionHumanAttention
  }

  start(): void {
    if (this.timer || this.suspended) {
      return
    }
    installDeliverableRepairs()
    const run = (): void => void this.tick().catch((error) => console.warn('[outcomes]', error))
    this.timer = setInterval(run, 2_000).unref()
    // The startup reconciliation: the first pass runs now, in this turn, not at the first cadence.
    run()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
  }

  /** Runs worth keeping a headless host alive for: never a sealed or an honestly failed one. */
  pendingOutcomes(): SessionChain[] {
    return pendingSessionOutcomeChains(this.runtime.listSessionChains(), this.now())
  }

  async suspend(): Promise<void> {
    this.suspended = true
    this.dispose()
    await Promise.allSettled([...this.pending.values(), this.launches.settled(), this.reconciling])
  }

  /**
   * Converge now instead of at the next cadence (continuation hand-over, a worker's exit, a
   * renderer refresh, the watchdog). Callers in one turn share a tick, and a request that arrives
   * while that tick runs gets exactly one more, so nothing is seen late. A commit needs no pass of
   * its own: `save` settles the committed record from the policy in the commit's own write, and
   * `start` (which every commit calls) is the startup pass.
   */
  reconcile(_reason: SessionOutcomeReconcileReason): Promise<void> {
    // A host that is not ticking (never started, disposed, suspended) has nothing to bring forward.
    if (!this.timer || this.suspended) {
      return Promise.resolve()
    }
    if (this.reconciling) {
      this.reconcileAgain = true
      return this.reconciling
    }
    const run = async (): Promise<void> => {
      await Promise.resolve()
      do {
        this.reconcileAgain = false
        await this.tick().catch((error) => console.warn('[outcomes]', error))
      } while (this.reconcileAgain && !this.suspended)
    }
    this.reconciling = run().finally(() => {
      this.reconciling = null
    })
    return this.reconciling
  }

  /** Persists a launch that outlived its tick, in the chain's own lane so no snapshot is undone. */
  launchedDetach(chainId: string): SessionOutcomeLaunchDetach {
    return this.launches.detachWith((attempt) =>
      this.serialize(chainId, async () => mergeSessionOutcomeAttempt(this, chainId, attempt))
    )
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => {
        if (this.suspended || !this.runtime.hasSessionOutcomeContinuation()) {
          throw new Error(
            'The execution host is not accepting outcome operations. Reconnect after continuation ownership is ready.'
          )
        }
        return operation()
      })
    this.pending.set(id, next)
    void next
      .finally(() => {
        if (this.pending.get(id) === next) {
          this.pending.delete(id)
        }
      })
      .catch(() => {})
    return next
  }

  get(id: string): SessionChain {
    const chain = this.runtime.listSessionChains().find((entry) => entry.id === id)
    if (!chain?.outcomeSet) {
      throw new Error('No committed outcome set was found.')
    }
    return chain
  }

  /**
   * The single terminal writer. State, the completion seal and the announcement stamps are all
   * read from the one lifecycle policy and land in one durable flush; a sealed record is final.
   */
  save(chain: SessionChain, expectedRevision: number): SessionChain {
    const chains = this.runtime.listSessionChains()
    const current = chains.find((entry) => entry.id === chain.id)
    // A review of this run not every named person approved keeps it open, held work or not.
    const held = upNextHeldContinuation(this.runtime, chain, chains)
    const settled = settleSessionOutcomeChain({ chain, current, now: this.now(), held })
    if (sameDurableSessionChain(current, settled.chain)) {
      // Why a copy: `current` is the shared frozen snapshot; a write returns its own copy too.
      return structuredClone(current!)
    }
    const saved = this.runtime.replaceSessionChainOutcomesAndFlush(
      settled.chain,
      // A sealed record is rewritten from itself, so the offered revision says nothing about it.
      current && isSealedOutcomeChain(current) ? current.outcomeSet!.revision : expectedRevision
    )
    acceptPersistedOutcomeWorkers(this.runtime, saved)
    observeOrchestrationOutcomeChange(current, saved)
    noteSessionOutcomeSaved(saved)
    if (settled.announce.length) {
      try {
        // After the flush: a request is announced at most once, never before its stamp is durable.
        this.announce(saved, settled.announce)
      } catch (error) {
        console.warn('[outcomes] attention announcement failed', saved.id, error)
      }
    }
    return saved
  }

  async commit(
    raw: unknown,
    input: SessionOutcomeCommit,
    authorityInstruction?: string,
    refreshAuthority?: () => string | undefined
  ): Promise<SessionChain> {
    if (!this.runtime.hasSessionOutcomeContinuation()) {
      throw new Error('This host cannot durably own session outcomes. Update the execution host.')
    }
    const base = raw as SessionChain
    if (!base || typeof base.id !== 'string') {
      throw new Error('Missing chain id.')
    }
    return this.serialize(base.id, async () => {
      let committed = await commitSessionOutcomeSet(
        this,
        base,
        input,
        authorityInstruction,
        refreshAuthority
      )
      for (const outcome of committed.outcomeSet!.outcomes.filter(
        (entry) => entry.evidence.length
      )) {
        if (isSealedOutcomeChain(committed)) {
          break
        }
        const verified = await verifySessionOutcomeProgress(
          this.runtime,
          committed,
          outcome,
          false,
          this.now()
        )
        committed = this.save(
          { ...committed, outcomeSet: verified.set },
          committed.outcomeSet!.revision
        )
      }
      return committed
    })
  }

  attach(
    id: string,
    outcomeId: string,
    taskId: string,
    expectedRevision: number
  ): Promise<SessionChain> {
    return this.serialize(id, () =>
      attachSessionOutcomeTask(this, id, outcomeId, taskId, expectedRevision)
    )
  }

  verify(
    id: string,
    expectedRevision: number,
    outcomeId: string,
    conditionId: string
  ): Promise<SessionChain> {
    return this.serialize(id, () =>
      verifySessionOutcomeOnRequest(this, id, expectedRevision, outcomeId, conditionId)
    )
  }

  review(
    id: string,
    expectedRevision: number,
    outcomeId: string,
    conditionId: string,
    version: string
  ): Promise<SessionChain> {
    return this.serialize(id, async () => {
      const chain = this.get(id)
      // A sealed run has nothing left to approve.
      return isSealedOutcomeChain(chain)
        ? chain
        : reviewSessionOutcomeCondition(this, id, expectedRevision, outcomeId, conditionId, version)
    })
  }

  /** The owner's keep waiting / continue anyway / cancel on a wait. */
  waitChoice(input: WaitChoiceInput): Promise<SessionChain> {
    return this.serialize(input.id, () => chooseSessionOutcomeWait(this, input))
  }

  async resume(id: string, expectedRevision: number): Promise<SessionChain> {
    return this.serialize(id, async () => {
      const chain = this.get(id)
      // Resume retries stopped work; a sealed run has none, and must never be reopened.
      if (isSealedOutcomeChain(chain)) {
        return chain
      }
      await assertSessionOutcomeExecutionScope(this.runtime, chain)
      if (chain.outcomeSet!.revision !== expectedRevision) {
        throw new Error('Outcome revision conflict.')
      }
      if (
        chain.outcomeSet!.continuation.principal &&
        (await readSessionOutcomePrincipal()) !== chain.outcomeSet!.continuation.principal
      ) {
        throw new Error('Restore the original signed company/person before resuming.')
      }
      return resumeSessionOutcomeWork(this, chain, this.now())
    })
  }

  async tick(): Promise<void> {
    if (this.suspended) {
      return
    }
    // The stall watchdog and the prompt queue own no chain and no outcome, so they run before —
    // and independently of — continuation ownership; `false` means outcomes are not this host's
    // to touch yet (`session-outcome-pre-tick.ts`).
    if (!(await runSessionOutcomePreTickWork(this.runtime, this.epoch, this.now()))) {
      return
    }
    for (const chain of this.runtime.listSessionChains()) {
      if (this.suspended || !this.runtime.hasSessionOutcomeContinuation()) {
        return
      }
      const duty = this.pending.has(chain.id) ? 'skip' : sessionOutcomeTickDuty(chain, this.now())
      if (duty === 'skip') {
        continue
      }
      await this.serialize(chain.id, async () => {
        if (duty === 'advance') {
          try {
            await advanceSessionOutcomes(this, this.get(chain.id), this.now())
          } catch (error) {
            blockOutcomesForTickFailure(this, chain.id, error, this.now())
          }
        }
        // The record may still contradict what it proves (complete but not done or not sealed,
        // failed work recorded as waiting): one save from the policy settles it.
        const fresh = this.get(chain.id)
        if (duty === 'repair' || sessionOutcomeStateDisagrees(fresh, this.now())) {
          this.save(fresh, fresh.outcomeSet!.revision)
        }
      }).catch((error) => {
        // Persistence can fail while recording the blocker; other chains still own runnable work.
        console.warn('[outcomes] Chain tick failed', chain.id, error)
      })
    }
  }

  /** What a window reported about closing or saving a finished session (`operationId`-fenced). */
  reportDisposition(id: string, report: SessionRunDispositionReport): Promise<SessionChain> {
    return this.serialize(id, async () =>
      reportSessionOutcomeDisposition(this, id, report, this.now())
    )
  }

  retryDisposition(id: string): Promise<SessionChain> {
    return this.serialize(id, async () => retrySessionOutcomeDisposition(this, id, this.now()))
  }
}
