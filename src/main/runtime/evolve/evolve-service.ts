import { randomUUID } from 'node:crypto'
import {
  EVOLVE_RUN_ID_PREFIX,
  type EvolveRunRecord,
  type EvolveStartRequest,
  type EvolveWorkflowRunRecord
} from '../../../shared/evolve-workflow'
import { workflowPlacementSummary } from '../../../shared/local-workflow-placement'
import { evolveRunNotFound } from '../../../shared/session-workflow-anchor'
import { admitEvolveRun, type EvolveAdmissionDeps } from './evolve-admission'
import { evolveStopScript, parseEvolveStop, runEvolveHostScript } from './evolve-host-commands'
import type { EvolveRunStore } from './evolve-run-store'
import { pushEvolveEvent, settleEvolveRun } from './evolve-run-progress'
import {
  followEvolveRun,
  launchEvolveRun,
  pollEvolveRun,
  resolveEvolveRecordTarget,
  type EvolveFollowContext
} from './evolve-service-follow'

export type EvolveServiceDeps = EvolveAdmissionDeps & {
  store: EvolveRunStore
  notify: (record: EvolveRunRecord) => void
  now?: () => number
  pollMs?: number
  /** How long without contact before following stops and the run reads `unverifiable`. */
  lostAfterMs?: number
  /** Invoked when a run settles (`done`, `failed`, or `stopped`). */
  onSettled?: (record: EvolveWorkflowRunRecord) => void | Promise<void>
}

/**
 * Evolve runs this computer started: admits a Start, submits the spec on the host, starts one
 * detached worker there and follows `status --json` until the ledger settles the run. The worker
 * outlives this app, so a restart resumes following instead of failing the run.
 */
export class EvolveService {
  private readonly runs = new Map<string, EvolveRunRecord>()
  private readonly following = new Set<string>()
  private readonly followCtx: EvolveFollowContext

  constructor(private readonly deps: EvolveServiceDeps) {
    this.followCtx = {
      deps,
      runs: this.runs,
      following: this.following,
      at: () => this.at(),
      changed: (record) => this.changed(record)
    }
    for (const record of deps.store.load()) {
      this.runs.set(record.id, record)
      this.resume(record)
    }
  }

  private at(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString()
  }

  private changed(record: EvolveRunRecord): void {
    this.deps.store.save(record)
    this.deps.notify(structuredClone(record))
  }

  private resume(record: EvolveRunRecord): void {
    if (record.state === 'running' && record.ledgerRunId && record.worker) {
      void followEvolveRun(this.followCtx, record.id)
      return
    }
    if (record.state === 'starting') {
      settleEvolveRun(
        record,
        'failed',
        this.at(),
        record.ledgerRunId
          ? `The app restarted before the worker started; ledger run ${record.ledgerRunId} stays queued until a worker claims it.`
          : `The app restarted while the spec was being submitted; if it was queued, the ledger holds a run submitted by ${record.submittedBy}.`
      )
      this.deps.store.save(record)
    }
  }

  list(): EvolveRunRecord[] {
    return [...this.runs.values()]
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => structuredClone(record))
  }

  show(id: string): EvolveRunRecord {
    const record = this.runs.get(id)
    if (!record) {
      throw new Error(evolveRunNotFound(id))
    }
    return structuredClone(record)
  }

  /** Admission refusals throw before anything is written; a recorded run then goes on alone. */
  async start(request: EvolveStartRequest, caller: { agent: boolean }): Promise<EvolveRunRecord> {
    const admitted = await admitEvolveRun(request, caller, this.deps)
    const at = this.at()
    const record: EvolveRunRecord = {
      id: `${EVOLVE_RUN_ID_PREFIX}${randomUUID()}`,
      createdAt: at,
      updatedAt: at,
      state: 'starting',
      ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      request,
      spec: admitted.spec,
      checkout: admitted.checkout,
      submittedBy: admitted.submittedBy,
      placement: admitted.placement,
      host: admitted.target.name,
      events: []
    }
    pushEvolveEvent(record, `Placed on ${workflowPlacementSummary(record.placement)}.`, at)
    this.deps.store.persist(record)
    this.runs.set(record.id, record)
    this.deps.notify(structuredClone(record))
    void launchEvolveRun(this.followCtx, record)
    return structuredClone(record)
  }

  /** SIGTERM to the worker: it settles its ledger run as failed, which the next reading records. */
  async stop(id: string): Promise<EvolveRunRecord> {
    const record = this.runs.get(id)
    if (!record?.worker || record.state !== 'running') {
      throw new Error('This Evolve run has no running worker to stop.')
    }
    const target = resolveEvolveRecordTarget(record)
    if (target.kind === 'hosted') {
      // omnisi-evolve-service has no cancel route; only its worker's lease can end the run.
      throw new Error(
        `${record.host} has no stop for hosted runs yet, so run ${record.cloudRunId ?? record.ledgerRunId} goes on there until it finishes or spends its budget.`
      )
    }
    const result = await runEvolveHostScript(this.deps, target, evolveStopScript(record.id), 30_000)
    const sent = result?.code === 0 ? parseEvolveStop(result.stdout) : undefined
    if (!sent) {
      throw new Error(
        `${record.host} could not be reached to stop the worker; the run goes on there.`
      )
    }
    record.stopRequestedAt = this.at()
    pushEvolveEvent(
      record,
      sent === 'sent'
        ? `Stop sent to the worker on ${record.host}.`
        : `The worker on ${record.host} had already exited.`,
      record.stopRequestedAt
    )
    this.changed(record)
    return structuredClone(record)
  }

  /** Reads the host once now; an unverifiable run whose host answers is followed again. */
  async refresh(id: string): Promise<EvolveRunRecord> {
    const record = this.runs.get(id)
    if (!record) {
      throw new Error(evolveRunNotFound(id))
    }
    if ((record.state === 'running' || record.state === 'unverifiable') && record.ledgerRunId) {
      const outcome = await pollEvolveRun(this.followCtx, record)
      if (outcome === 'live' && record.state === 'running') {
        void followEvolveRun(this.followCtx, id)
      }
    }
    return structuredClone(record)
  }
}
