import { transferBrief } from './session-transfer-brief'
export { transferBrief } from './session-transfer-brief'
import type { SessionTransferResult } from '../../shared/session-transfer-types'
import { requireTransferAcknowledgement } from './session-transfer-acknowledgement'
import { sessionTransferReservation } from './session-transfer-reservation'
import {
  assertSameTransferSession,
  assertCreatedTransferSession
} from './session-transfer-identity'
import {
  hostMoveSteps,
  transferDryRunSummary,
  transferSteps,
  transferTargetTitle
} from './session-transfer-steps'
import { eligibleTransferSources } from './session-transfer-sources'
import { TRANSFER_HANDOFF_QUESTION, TRANSFER_SUMMARY_QUESTION } from './session-transfer-questions'
import {
  HostedTransferSources,
  routeHostedTransferSources
} from './session-transfer-hosted-sources'
import {
  startTransferResult,
  transferAbortCheck,
  transferAuditTrail,
  transferCompletedSummary
} from './session-transfer-audit-trail'
import { adoptTransferredWork } from './session-transfer-adoption'
import { assertUnattendedPolicy } from './session-manage-unattended'
import {
  assertHostTarget,
  ensureSourcesPushed,
  hostLaunchPrompt,
  hostMoveResult,
  planHostMove,
  unreachableHostNote
} from './session-transfer-host'
import type { HostMovePlan } from './session-transfer-host-contract'
import {
  answered,
  assertTransferSession,
  auditTransferFailure,
  transferFailureSummary,
  transferIdentity,
  transferSummary,
  type SessionTransferDeps,
  type SessionTransferInput,
  type SessionTransferMode,
  type TransferAudit,
  type TransferPending,
  type TransferSession
} from './session-manage-transfer-contract'

export async function transferSessions(
  deps: SessionTransferDeps,
  requested: SessionTransferInput,
  mode: SessionTransferMode
): Promise<SessionTransferResult> {
  const input = await routeHostedTransferSources(deps.hosted, requested)
  const { actor, dryRun } = input
  // D5: merging runs on the person's yes; a steward run can only suggest it.
  assertUnattendedPolicy(actor, mode)
  const reservation = sessionTransferReservation()
  const hosted = new HostedTransferSources(deps.hosted, input, mode)
  // What a new target copies its agent, workspace and folder from: a source on this computer.
  const template = (): TransferSession => sources[0] ?? hosted.template()!
  let target = input.target
  const result = startTransferResult(input, mode)
  let step = 'validate'
  // What a step is about to change, so a partial failure of that step is audited against it.
  let changing: Pick<TransferAudit, 'action' | 'target'> | null = null
  const { applied, audit } = transferAuditTrail(deps, input, mode, result)
  const checkAbort = transferAbortCheck(deps.signal)
  const sources: TransferSession[] = []
  // Set only for a move to another computer (`--host`).
  let move: HostMovePlan | null = null
  // Every question to a source re-checks that source first and is audited once queued.
  const recheck = async (source: TransferSession): Promise<TransferSession> => {
    const fresh = await deps.refresh(source)
    assertSameTransferSession(source, fresh)
    assertTransferSession(actor, fresh)
    return fresh
  }
  const askSource = async (source: TransferSession, question: string, summary: string) => {
    checkAbort()
    const fresh = await recheck(source)
    changing = { action: 'ask', target: fresh }
    const queued = await deps.ask(fresh, question)
    changing = null
    await audit({ action: 'ask', target: fresh, summary, after: { queued: queued.sent } })
    return answered(await queued.wait)
  }
  try {
    checkAbort()
    sources.push(...eligibleTransferSources(input, mode, result.skipped, hosted.count))
    hosted.validate(input, sources.length)
    result.sources = [...sources.map(transferIdentity), ...hosted.identities()]
    const named = [...sources, ...hosted.briefSources()]
    const title = transferTargetTitle(mode, named)
    if (input.host) {
      move = await planHostMove(deps.host, input.host, target, sources)
      result.host = hostMoveResult(move, sources)
    }
    result.steps = move
      ? hostMoveSteps(mode, sources, move, title)
      : [...hosted.steps(), ...transferSteps(mode, sources, target, template())]
    if (dryRun) {
      result.summary = transferSummary({
        ...result,
        summary: transferDryRunSummary(mode, named, move, result.target.title)
      })
      return result
    }
    reservation.acquire([...sources, ...(target === 'new' ? [] : [target])])
    step = 'reserve sources on other computers'
    await hosted.reserve(input, target, result.skipped)
    result.sources = [...sources.map(transferIdentity), ...hosted.identities()]
    if (mode === 'consolidate' && sources.length + hosted.count < 2) {
      throw new Error('At least two eligible sources must remain after skipping busy sessions.')
    }
    if (move) {
      step = 'push source work'
      const { label } = move
      await ensureSourcesPushed(deps.host!, sources, move.works, (source, question) =>
        askSource(
          source,
          question,
          `Asked “${source.entry.title}” to push its branch before moving to ${label}.`
        )
      )
    }
    const briefs: string[] = []
    for (const source of sources) {
      step = `ask ${source.entry.title}`
      const question = mode === 'handoff' ? TRANSFER_HANDOFF_QUESTION : TRANSFER_SUMMARY_QUESTION
      briefs.push(
        await askSource(source, question, `Asked “${source.entry.title}” for a ${mode} brief.`)
      )
    }
    briefs.push(
      ...(await hosted.briefs((name) => {
        step = `ask ${name}`
      }))
    )
    const briefed = [...sources, ...hosted.briefSources()]
    let pending!: TransferPending
    if (move) {
      step = 'launch on host'
      checkAbort()
      deps.assertCheckpoints(sources)
      const brief = transferBrief(mode, briefed, briefs, input.note)
      const ready = await hostLaunchPrompt(deps.host!, move, sources, brief)
      move = ready.plan
      result.host = hostMoveResult(move, sources)
      changing = { action: 'session.create', target: sources[0] }
      const launched = await deps.host!.launch(move, sources[0], title, ready.prompt)
      changing = null
      target = launched.target
      pending = launched.pending
      result.target = transferIdentity(target)
      result.briefSent = true
      await audit({
        action: 'session.create',
        target,
        summary: `Started “${title}” on ${move.label} in ${move.workspace.path} with the ${mode} brief of ${result.sources.map((one) => `“${one.title}”`).join(', ')}.`,
        after: { queued: pending.sent, host: move.hostId, workspace: move.workspace.id }
      })
      reservation.acquire([target])
    } else if (target === 'new') {
      step = 'create target'
      checkAbort()
      changing = { action: 'session.create', target: template() }
      target = await deps.create(template(), title)
      changing = null
      result.target = transferIdentity(target)
      await audit({ action: 'session.create', target, summary: `Created “${title}”.` })
      reservation.acquire([target])
      step = 'wait for target launch'
      const launched = await deps.refresh(target, true)
      assertCreatedTransferSession(target, launched)
      target = launched
      reservation.acquire([target])
    }
    if (input.target === 'new') {
      step = 'file target'
      changing = { action: 'session.move', target }
      await deps.file(target, template())
      changing = null
      await audit({
        action: 'session.move',
        target,
        summary: `Filed “${title}” in ${template().entry.folder ?? 'unfiled'}.`
      })
    }
    if (!move) {
      step = 'deliver brief'
      checkAbort()
      deps.assertCheckpoints(sources)
      await hosted.recheck()
      const freshTarget = await deps.refresh(target)
      assertSameTransferSession(target, freshTarget)
      target = freshTarget
      assertTransferSession(actor, target, true)
      result.target = transferIdentity(target)
      changing = { action: 'continue', target }
      pending = await deps.deliver(target, transferBrief(mode, briefed, briefs, input.note))
      changing = null
      result.briefSent = true
      await audit({
        action: 'continue',
        target,
        summary: `Queued the ${mode} brief for “${target.entry.title}”.`,
        after: { queued: pending.sent }
      })
    }
    step = 'acknowledgement'
    const outcome = await pending.wait
    if (outcome.outcome === 'timeout' && outcome.question === 'withdrawn') {
      result.briefSent = false
    }
    const reply = answered(outcome)
    requireTransferAcknowledgement(reply, pending.acknowledgement)
    result.acknowledgement = reply
    await audit({
      action: 'session.acknowledge',
      target,
      summary: `“${target.entry.title}” acknowledged the ${mode} brief.`,
      after: { reply }
    })
    step = 'adopt unfinished work'
    const adopted = await adoptTransferredWork({
      sources: [...sources, ...hosted.localSessions()],
      target
    })
    // Why only now: a hosted source is archived at its host once accepted, so adoption comes first.
    hosted.markAcknowledged()
    step = 'archive sources'
    checkAbort()
    const acknowledgedTarget = await deps.refresh(target)
    if (move) {
      assertHostTarget(target, acknowledgedTarget, move)
    } else {
      assertSameTransferSession(target, acknowledgedTarget)
      assertTransferSession(actor, acknowledgedTarget, true)
    }
    const freshSources: TransferSession[] = []
    for (const source of sources) {
      freshSources.push(await recheck(source))
    }
    checkAbort()
    const where = move ? ` on ${move.label}` : ''
    const reason = `${mode === 'handoff' ? 'handed off to' : 'consolidated into'} ${target.entry.title}${where}`
    const guard = (): boolean => {
      checkAbort()
      deps.assertCheckpoints([...freshSources, acknowledgedTarget])
      return true
    }
    guard()
    result.archiveOutcome = 'unknown'
    const archive = freshSources.length
      ? await deps.archive(freshSources, reason, guard, acknowledgedTarget)
      : ({ status: 'archived' } as const)
    result.archiveOutcome = archive.status
    if (archive.status !== 'archived') {
      throw new Error(archive.reason)
    }
    result.archived = sources.map(transferIdentity)
    for (const source of freshSources) {
      await audit({
        action: 'session.archive',
        target: source,
        summary: `Archived “${source.entry.title}”: ${reason}.`,
        reason,
        after: { archived: true }
      })
    }
    if (result.host) {
      result.host.verdict = 'live'
    }
    result.outcome = 'completed'
    result.summary = transferCompletedSummary(mode, target, where, sources.length, adopted)
  } catch (error) {
    result.outcome = 'failed'
    result.failedStep = step
    result.failure = error instanceof Error ? error.message : String(error)
    await auditTransferFailure(error, changing, result, sources, audit)
    const unreachable = unreachableHostNote(deps.host, input.host, result)
    result.summary = `${transferFailureSummary(mode, step, result)}${unreachable}`
  } finally {
    deps.dispose?.()
    reservation.release()
  }
  // Why after everything: each source on another computer is settled at its host, whatever failed here.
  await hosted.settleInto(result, target)
  if (applied.length > 0) {
    result.applied = applied
  }
  result.summary = transferSummary(result)
  if (applied.length > 0) {
    await audit({
      action: mode,
      target: target === 'new' ? template() : target,
      summary: result.summary,
      after: result
    })
  }
  return result
}
