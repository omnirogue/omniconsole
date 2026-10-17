/**
 * `session relocate`: move the SAME conversation to another computer, as its own explicit
 * operation (a handoff starts a new conversation instead). Prepare the destination, freeze and
 * export the source under one reservation, copy and stage the bundle, then transfer authority: the
 * source relinquishes durably and grants the next owner epoch to exactly one destination, which
 * resumes the same provider identity once. Unattended callers only propose it. Each phase whose
 * result is recorded is skipped on a continuation and the one in flight is resent identically, so
 * a lost reply is answered by the host's own record; nothing ever restarts a relinquished source.
 */

import type { SessionRelocationResult } from '../../shared/session-relocation-types'
import {
  observeRelocationSource,
  relocationBundleSupport,
  relocationProposal
} from './session-transfer-relocate-plan'
import {
  copyAndStagePhase,
  freezeAndExportPhase,
  prepareRelocationDestinationPhase,
  relinquishPhase,
  resumePhase
} from './session-transfer-relocate-phases'
import {
  RelocationRun,
  RelocationStop,
  type SessionRelocateDeps,
  type SessionRelocateInput
} from './session-transfer-relocate-run'

export type { SessionRelocateDeps, SessionRelocateInput } from './session-transfer-relocate-run'

export async function relocateConversation(
  deps: SessionRelocateDeps,
  input: SessionRelocateInput
): Promise<SessionRelocationResult> {
  const run = new RelocationRun(deps, input)
  try {
    return await begin(run)
  } catch (error) {
    if (!(error instanceof RelocationStop)) {
      throw error
    }
    await run.settle(error.outcome)
    return run.result(error.outcome, error.summary, error.code)
  }
}

async function begin(run: RelocationRun): Promise<SessionRelocationResult> {
  const { deps, input } = run
  if (!deps.relocationEnabled()) {
    throw new RelocationStop(
      'refused',
      'Moving conversations is turned off on this computer. Nothing was changed.',
      'relocation-disabled'
    )
  }
  if (deps.source.hostId === deps.destination.hostId) {
    throw new RelocationStop(
      'refused',
      `That conversation already runs on ${run.destination}. Nothing was changed.`,
      'invalid-request'
    )
  }
  if (input.relocation) {
    run.record = await deps.records.read(input.relocation)
    if (!run.record || run.record.source.conversationId !== input.conversationId) {
      throw new RelocationStop(
        'refused',
        'This computer has no record of that move for this conversation. Nothing was changed.',
        'invalid-request'
      )
    }
    const { phase } = run.record
    if (phase === 'abandoned' || phase === 'relocated') {
      return run.result(phase, `That move already ended (${phase}). Nothing was changed.`)
    }
    return await proceed(run)
  }
  const observed = await observeRelocationSource(deps.source, input.conversationId)
  if ('stop' in observed) {
    throw new RelocationStop('refused', observed.stop, observed.code)
  }
  run.observed = observed.row
  const unsupported = await relocationBundleSupport(deps, input.conversationId, observed.provider)
  if (unsupported) {
    throw new RelocationStop('refused', unsupported.stop, unsupported.code)
  }
  const { requester } = input.origin
  if (requester.kind !== 'person' && requester.unattended) {
    return run.result('proposed', relocationProposal(deps, observed.row))
  }
  if (input.dryRun) {
    return run.result(
      'planned',
      `Would move this conversation from ${run.source} to ${run.destination}: prepare ${run.destination}, freeze and export it on ${run.source}, stage it there, hand ownership over, and resume the same conversation there once. Nothing changed.`
    )
  }
  run.record = {
    v: 1,
    relocation: deps.mintOperationId(),
    provider: observed.provider,
    source: {
      hostId: deps.source.hostId,
      conversationId: input.conversationId,
      ownerEpoch: observed.row.ownerEpoch
    },
    destination: { hostId: deps.destination.hostId },
    requests: {},
    steps: [],
    phase: 'running',
    updatedAt: deps.now()
  }
  await run.save()
  return await proceed(run)
}

async function proceed(run: RelocationRun): Promise<SessionRelocationResult> {
  const record = run.current
  if (record.releasing) {
    return await run.abandon(null, 'it was already being abandoned')
  }
  if (!record.grant) {
    if (!record.stagingDir) {
      await prepareRelocationDestinationPhase(run)
    }
    if (!record.manifest) {
      await freezeAndExportPhase(run)
    }
    if (!record.staged) {
      await copyAndStagePhase(run)
    }
    await relinquishPhase(run)
  }
  return await resumePhase(run, run.current.grant!)
}
