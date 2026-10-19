import { randomUUID } from 'node:crypto'
import type { SpecPrBatch, SpecPrBatchStart } from '../../shared/spec-pr-batch'
import { specPrBatchStartSchema } from '../../shared/spec-pr-batch'
import { createOrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { createDesktopCoordinator } from '../runtime/orchestration/desktop-coordinator'
import { admitOrchestrationRun } from '../runtime/orchestration/run-admission'
import { prepareSpecPrBatchSlots } from './spec-pr-batch-preflight'
import {
  currentSpecPrScope,
  listSpecPrBatches,
  saveSpecPrBatch,
  specSourceDigest
} from './spec-pr-batch-store'
import { refreshSpecPrBatch } from './spec-pr-batch-verification'

export class SpecPrBatchService {
  private readonly active = new Set<string>()
  private readonly refreshes = new Map<string, Promise<SpecPrBatch>>()
  private startQueue: Promise<void> = Promise.resolve()

  constructor(private readonly runtime: OrcaRuntimeService) {
    if (this.available()) {
      const timer = setInterval(() => {
        try {
          for (const batch of this.list().slice(0, 20)) {
            if (
              batch.slots.some((slot) =>
                ['building', 'verifying', 'waiting', 'unverifiable'].includes(slot.phase)
              )
            ) {
              void this.refresh(batch.id).catch(() => undefined)
            }
          }
        } catch {
          /* The signed-in profile may be changing. */
        }
      }, 30_000)
      timer.unref()
    }
  }

  available(): boolean {
    return process.env.ORCA_SPEC_PR_BATCH_ENABLED === '1'
  }

  list(): SpecPrBatch[] {
    return listSpecPrBatches(this.active)
  }

  get(id: string): SpecPrBatch {
    const batch = this.list().find((candidate) => candidate.id === id)
    if (!batch) {
      throw new Error('This batch does not belong to the signed-in account.')
    }
    return batch
  }

  start(input: SpecPrBatchStart): Promise<SpecPrBatch> {
    const started = this.startQueue.then(() => this.reserve(input))
    this.startQueue = started.then(
      () => undefined,
      () => undefined
    )
    return started
  }

  private async reserve(input: SpecPrBatchStart): Promise<SpecPrBatch> {
    if (!this.available()) {
      throw new Error('Spec batches are disabled on this execution host.')
    }
    const request = specPrBatchStartSchema.parse(input)
    const scope = currentSpecPrScope()
    const prior = this.list().find(
      (batch) =>
        batch.mutationId === request.mutationId ||
        JSON.stringify(
          batch.slots.map(({ artifactSlug, revision, decisionId, repoId, baseRef }) => ({
            artifactSlug,
            revision,
            decisionId,
            repoId,
            baseRef
          }))
        ) === JSON.stringify(request.targets)
    )
    if (prior) {
      return prior
    }
    const keys = request.targets.map((item) => JSON.stringify(item))
    if (new Set(keys).size !== 5) {
      throw new Error('Choose five distinct spec and repository targets.')
    }
    const id = `spb_${randomUUID()}`
    const slots = await prepareSpecPrBatchSlots(this.runtime, request, scope, id, () => {
      if (currentSpecPrScope().principal !== scope.principal) {
        throw new Error('The signed-in account changed.')
      }
    })
    const now = new Date().toISOString()
    const batch: SpecPrBatch = {
      version: 1,
      id,
      mutationId: request.mutationId,
      principal: scope.principal,
      executionHostId: 'local',
      agent: request.agent,
      stopped: false,
      createdAt: now,
      updatedAt: now,
      slots: slots as SpecPrBatch['slots']
    }
    this.save(batch)
    void this.launch(batch).catch((error) => {
      const pending = batch.slots.find(
        (slot) => slot.phase === 'checking' || slot.phase === 'reserved'
      )
      if (pending) {
        pending.phase = 'unverifiable'
        pending.reason = String(error)
        this.save(batch)
      }
    })
    return batch
  }

  stop(id: string): SpecPrBatch {
    const batch = this.get(id)
    batch.stopped = true
    this.save(batch)
    return batch
  }

  refresh(id: string): Promise<SpecPrBatch> {
    const pending = this.refreshes.get(id)
    if (pending) {
      return pending
    }
    const batch = this.get(id)
    if (this.active.has(id)) {
      return Promise.resolve(batch)
    }
    const refresh = refreshSpecPrBatch(
      this.runtime,
      batch,
      (updated) => this.save(updated),
      () => this.get(id).stopped
    ).finally(() => this.refreshes.delete(id))
    this.refreshes.set(id, refresh)
    return refresh
  }

  private async launch(batch: SpecPrBatch): Promise<void> {
    if (this.active.has(batch.id)) {
      return
    }
    this.active.add(batch.id)
    try {
      const first = batch.slots[0]
      const listed = await this.runtime.listManagedWorktrees(first.repoId, 1000)
      const owner = listed.worktrees.find((worktree) => worktree.git.isMainWorktree)
      if (!owner || listed.truncated) {
        throw new Error('The coordinator repository has no inspectable main workspace.')
      }
      const handle = await createDesktopCoordinator(
        this.runtime,
        owner.id,
        'Spec PR batch coordinator',
        { launchCause: { trigger: 'workflow', reference: { workflowRunId: batch.id.slice(4) } } }
      )
      batch.coordinatorHandle = handle
      const run = admitOrchestrationRun({
        runtime: this.runtime,
        objective: `Build ${batch.slots.length} approved specs`,
        callerTerminalHandle: handle
      })
      batch.runId = run.run.id
      this.save(batch)
      const db = this.runtime.getOrchestrationDb()
      const call = createOrchestrationCaller(this.runtime)
      for (const slot of batch.slots) {
        const created = await call<{ task: { id: string } }>(
          'orchestration.taskCreate',
          {
            run: run.run.id,
            callerTerminalHandle: handle,
            taskTitle: slot.title,
            spec: `Implement approved spec ${slot.artifactSlug} revision ${slot.revision} from ${slot.snapshotPath}.`
          },
          { requestId: `${batch.id}:${slot.index}:task-create` }
        )
        slot.taskId = created.task.id
        this.save(batch)
      }
      await Promise.all(
        batch.slots.map(async (slot) => {
          if (this.get(batch.id).stopped) {
            batch.stopped = true
            return
          }
          if (currentSpecPrScope().principal !== batch.principal) {
            throw new Error('The signed-in account changed.')
          }
          slot.phase = 'checking'
          this.save(batch)
          const review = await this.runtime.getArtifactReviewStatus({ slug: slot.artifactSlug })
          if (
            review.status !== 'ok' ||
            review.value.status !== 'approved' ||
            review.value.latest?.id !== slot.decisionId ||
            review.value.artifact.revision !== slot.revision
          ) {
            slot.phase = 'waiting'
            slot.reason = 'Approval changed before builder launch.'
            this.save(batch)
            return
          }
          const source = await this.runtime.readArtifactContextDocument(slot.artifactSlug)
          if (
            source.status !== 'ok' ||
            source.value.truncated ||
            specSourceDigest(source.value.content) !== slot.sourceSha256
          ) {
            slot.phase = 'waiting'
            slot.reason = 'The source changed before builder launch.'
            this.save(batch)
            return
          }
          if (this.get(batch.id).stopped) {
            batch.stopped = true
            return
          }
          const siblings = batch.slots
            .filter((item) => item !== slot)
            .map((item) => item.title)
            .join('; ')
          const brief =
            `Implement only this approved spec in ${slot.repoRemote}, base ${slot.baseRef} (${slot.baseOid}).\n` +
            `Read the complete frozen spec from ${slot.snapshotPath} (JSON content field; SHA-256 ${slot.sourceSha256}).\n` +
            `Approval: ${slot.artifactSlug} revision ${slot.revision}, decision ${slot.decisionId}.\n` +
            `Sibling specs owned by other builders: ${siblings}. Do not take their work.\n` +
            'Read repository AGENTS.md and related work. Implement, run targeted checks, commit, and push. Report the branch and evidence with the task and dispatch IDs. The IDE opens the draft PR after verification. Never merge or deploy.'
          try {
            const started = await call<{ dispatchId: string; state: string }>(
              'orchestration.workerStart',
              {
                task: slot.taskId!,
                run: run.run.id,
                from: handle,
                worktree: 'new-top-level',
                repo: `id:${slot.repoId}`,
                baseBranch: slot.baseOid,
                name: `spec-${batch.id.slice(-8)}-${slot.index + 1}`,
                agent: batch.agent,
                setup: 'inherit',
                executionBrief: brief,
                timeoutMs: 180_000
              },
              { requestId: `${batch.id}:${slot.index}:worker-start` }
            )
            slot.dispatchId = started.dispatchId
            const worker = db.getWorkerDispatch(started.dispatchId)
            slot.worktreeId = worker?.worktree_id ?? undefined
            slot.terminalHandle = worker?.agent_terminal_handle ?? undefined
            if (slot.worktreeId) {
              const workspace = await this.runtime.showManagedTerminalWorkspace(
                `id:${slot.worktreeId}`
              )
              slot.branch = workspace.git.branch.replace(/^refs\/heads\//, '')
              slot.worktreePath = workspace.git.path
            }
            slot.phase = started.state === 'ready' && slot.worktreeId ? 'building' : 'unverifiable'
            if (slot.phase === 'unverifiable') {
              slot.reason = 'Worker start needs receipt reconciliation.'
            }
          } catch {
            slot.phase = 'unverifiable'
            slot.reason =
              'Worker start failed or its outcome is unknown; inspect the task before retrying.'
          }
          this.save(batch)
        })
      )
    } finally {
      this.active.delete(batch.id)
    }
  }

  private save(batch: SpecPrBatch): void {
    saveSpecPrBatch(batch)
  }
}

const services = new WeakMap<OrcaRuntimeService, SpecPrBatchService>()
export function getSpecPrBatchService(runtime: OrcaRuntimeService): SpecPrBatchService {
  let service = services.get(runtime)
  if (!service) {
    service = new SpecPrBatchService(runtime)
    services.set(runtime, service)
  }
  return service
}
