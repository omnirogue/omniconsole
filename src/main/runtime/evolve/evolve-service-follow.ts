import {
  isHostedEvolveRun,
  type EvolveRunRecord,
  type EvolveWorkflowRunRecord
} from '../../../shared/evolve-workflow'
import { workflowFleetFailure } from '../workflow-script/workflow-fleet-remote-shell'
import { evolveHostTarget, type EvolveAdmissionDeps } from './evolve-admission'
import {
  evolveNoAnswer,
  evolvePollScript,
  evolveSubmitScript,
  evolveWorkerScript,
  parseEvolvePoll,
  parseEvolveSubmit,
  parseEvolveWorker,
  runEvolveHostScript,
  type EvolveHostTarget
} from './evolve-host-commands'
import {
  applyEvolvePoll,
  evolveSubmitFailure,
  markEvolveContactLive,
  pushEvolveEvent,
  settleEvolveRun
} from './evolve-run-progress'
import { followHostedEvolveEvents, type EvolveHostedStreamDeps } from './evolve-hosted-stream'
import { pollHostedEvolveRun, startHostedEvolveRun } from './hosted-evolve-client'
import { HostedEvolveOutcomeUnknownError } from './hosted-evolve-outcome'

export const EVOLVE_POLL_MS = 15_000
export const EVOLVE_LOST_AFTER_MS = 60 * 60_000

export type EvolveFollowContext = {
  deps: EvolveAdmissionDeps &
    EvolveHostedStreamDeps & {
      now?: () => number
      pollMs?: number
      lostAfterMs?: number
      onSettled?: (record: EvolveWorkflowRunRecord) => void | Promise<void>
    }
  runs: Map<string, EvolveRunRecord>
  following: Set<string>
  at: () => string
  changed: (record: EvolveRunRecord) => void
}

export function resolveEvolveRecordTarget(record: EvolveRunRecord): EvolveHostTarget {
  if (isHostedEvolveRun(record)) {
    return { kind: 'hosted', name: record.host || 'Omnisi Cloud' }
  }
  const target = evolveHostTarget(record.placement)
  if (!target) {
    throw new Error(`${record.host} has no SSH alias to reach it by.`)
  }
  return target
}

export function notifyEvolveRunSettled(ctx: EvolveFollowContext, record: EvolveRunRecord): void {
  const callback = ctx.deps.onSettled
  if (!callback) {
    return
  }
  try {
    void Promise.resolve(callback(structuredClone(record))).catch(() => {})
  } catch {
    // Settlement hooks must never fail the Evolve runtime loop.
  }
}

export async function launchEvolveRun(
  ctx: EvolveFollowContext,
  record: EvolveRunRecord
): Promise<void> {
  try {
    const target = resolveEvolveRecordTarget(record)
    if (target.kind === 'hosted') {
      const started = await startHostedEvolveRun(
        { ...record.request, checkout: record.checkout },
        ctx.deps.hosted
      )
      const at = ctx.at()
      record.cloudRunId = started.cloudRunId
      record.ledgerRunId = started.cloudRunId
      record.executionTier =
        started.executionTier ?? record.request.executionTier ?? 'hosted_super_intelligence'
      record.estimatedCredits = started.estimatedCredits ?? record.request.estimatedCredits
      record.submitted = {
        specSha: started.specSha,
        target: started.target,
        iterations: started.iterations,
        usdCap: started.usdCap,
        seedFrom: started.seedFrom ?? record.request.seedFrom ?? null,
        rubricFrom: started.rubricFrom ?? record.request.rubricFrom ?? null
      }
      if (started.ledger) {
        record.ledger = started.ledger
        record.ledgerReadAt = at
      }
      if (started.promotionSummary) {
        record.promotionSummary = started.promotionSummary
      }
      if (started.winnerArtifact) {
        record.winnerArtifact = started.winnerArtifact
      }
      record.worker = { pid: 0, directory: 'omnisi-cloud', startedAt: at }
      record.state = 'running'
      pushEvolveEvent(
        record,
        `Hosted Super Intelligence run ${started.cloudRunId} started on ${record.host}.`,
        at
      )
      ctx.changed(record)
      await followEvolveRun(ctx, record.id)
      return
    }
    const submitted = await runEvolveHostScript(
      ctx.deps,
      target,
      evolveSubmitScript({
        ...record.request,
        checkout: record.checkout,
        spec: record.spec,
        submittedBy: record.submittedBy
      }),
      180_000
    )
    const result = submitted?.code === 0 ? parseEvolveSubmit(submitted.stdout) : undefined
    if (!result) {
      settleEvolveRun(record, 'failed', ctx.at(), evolveSubmitFailure(record, submitted))
      ctx.changed(record)
      notifyEvolveRunSettled(ctx, record)
      return
    }
    record.ledgerRunId = result.run_id
    record.submitted = {
      specSha: result.spec_sha,
      target: result.target,
      iterations: result.iterations,
      usdCap: result.usd_cap,
      seedFrom: result.seed_from ?? null,
      rubricFrom: result.rubric_from ?? null
    }
    pushEvolveEvent(record, `Submitted: ledger run ${result.run_id} is queued.`, ctx.at())
    ctx.changed(record)
    const launched = await runEvolveHostScript(
      ctx.deps,
      target,
      evolveWorkerScript({
        checkout: record.checkout,
        runId: record.id,
        host: record.placement.host?.name ?? record.host,
        ledgerRunId: result.run_id
      }),
      30_000
    )
    const worker = launched?.code === 0 ? parseEvolveWorker(launched.stdout) : undefined
    if (!worker) {
      const why = workflowFleetFailure(record.host, 'start the worker', launched)
      settleEvolveRun(
        record,
        'failed',
        ctx.at(),
        `${why} Ledger run ${result.run_id} stays queued.`
      )
      ctx.changed(record)
      notifyEvolveRunSettled(ctx, record)
      return
    }
    record.worker = { ...worker, startedAt: ctx.at() }
    record.state = 'running'
    pushEvolveEvent(record, `Worker pid ${worker.pid} started on ${record.host}.`, ctx.at())
    ctx.changed(record)
    await followEvolveRun(ctx, record.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof HostedEvolveOutcomeUnknownError && !record.cloudRunId) {
      // Accepted-but-unanswered is possible: the paid run may exist, so it is never "failed".
      const at = ctx.at()
      record.state = 'unverifiable'
      record.contact = { verdict: 'unverifiable', at, detail: message }
      pushEvolveEvent(
        record,
        `${record.host} did not confirm the start (${message}). The run may have started there and be spending credits; this app has no cloud run id to follow it, so check your Omnisi Cloud Evolve runs before starting again.`,
        at
      )
      ctx.changed(record)
      return
    }
    settleEvolveRun(record, 'failed', ctx.at(), message)
    ctx.changed(record)
    notifyEvolveRunSettled(ctx, record)
  }
}

export async function pollEvolveRun(
  ctx: EvolveFollowContext,
  record: EvolveRunRecord
): Promise<'settled' | 'live' | 'lost'> {
  const target = resolveEvolveRecordTarget(record)
  if (target.kind === 'hosted') {
    const at = ctx.at()
    try {
      const polled = await pollHostedEvolveRun(
        record.cloudRunId ?? record.ledgerRunId!,
        ctx.deps.hosted
      )
      if (polled.ledger) {
        record.ledger = polled.ledger
        record.ledgerReadAt = at
      }
      if (polled.promotionSummary) {
        record.promotionSummary = polled.promotionSummary
      }
      if (polled.winnerArtifact) {
        record.winnerArtifact = polled.winnerArtifact
      }
      const { status } = polled
      if (status === 'done' || status === 'failed' || status === 'stopped') {
        record.contact = { verdict: 'exited', at }
        settleEvolveRun(record, status, at, polled.error)
        ctx.changed(record)
        notifyEvolveRunSettled(ctx, record)
        return 'settled'
      }
      markEvolveContactLive(record, at)
      ctx.changed(record)
      return 'live'
    } catch (error) {
      record.contact = {
        verdict: 'unverifiable',
        at,
        detail: error instanceof Error ? error.message : String(error)
      }
      ctx.changed(record)
      return 'lost'
    }
  }
  const script = evolvePollScript({
    checkout: record.checkout,
    runId: record.id,
    ledgerRunId: record.ledgerRunId!
  })
  const result = await runEvolveHostScript(ctx.deps, target, script, 60_000)
  const poll = result?.code === 0 ? parseEvolvePoll(result.stdout) : undefined
  const why =
    evolveNoAnswer(record.host, 'report the worker', result) ??
    workflowFleetFailure(record.host, 'report the worker', result)
  const outcome = applyEvolvePoll(record, poll, why, ctx.at())
  ctx.changed(record)
  if (outcome === 'settled') {
    notifyEvolveRunSettled(ctx, record)
  }
  return outcome
}

export async function followEvolveRun(ctx: EvolveFollowContext, id: string): Promise<void> {
  if (ctx.following.has(id)) {
    return
  }
  ctx.following.add(id)
  let lostSince: number | undefined
  const initial = ctx.runs.get(id)
  // Hosted runs stream live progress; polling below still decides when the run ends.
  const stream =
    initial?.state === 'running' && isHostedEvolveRun(initial)
      ? followHostedEvolveEvents(ctx, id)
      : undefined
  try {
    for (;;) {
      const record = ctx.runs.get(id)
      if (!record || record.state !== 'running') {
        return
      }
      const outcome = await pollEvolveRun(ctx, record)
      if (outcome === 'settled') {
        return
      }
      const now = ctx.deps.now?.() ?? Date.now()
      lostSince = outcome === 'lost' ? (lostSince ?? now) : undefined
      if (
        lostSince !== undefined &&
        now - lostSince >= (ctx.deps.lostAfterMs ?? EVOLVE_LOST_AFTER_MS)
      ) {
        record.state = 'unverifiable'
        pushEvolveEvent(
          record,
          `Lost contact with ${record.host}; the worker there is unverifiable and may still be running. Check again to resume following.`,
          ctx.at()
        )
        ctx.changed(record)
        return
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ctx.deps.pollMs ?? EVOLVE_POLL_MS).unref?.()
      })
    }
  } finally {
    stream?.close()
    ctx.following.delete(id)
  }
}
