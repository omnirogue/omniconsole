/**
 * The phases of `session relocate`, in order. Each records its result before returning, so a
 * continuation skips it; the grant is saved the moment the source issues it, because from then on
 * it is the only way the conversation runs anywhere.
 */

import type { SessionHostOwnershipGrant } from '../../shared/session-host-identity'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import type { SessionRelocationResult } from '../../shared/session-relocation-types'
import { resultField, type RelocationStepRequest } from './session-transfer-relocate-plan'
import { noteRelocationStep } from './session-transfer-relocate-record'
import { RelocationStop, UNANSWERED, type RelocationRun } from './session-transfer-relocate-run'

export async function prepareRelocationDestinationPhase(run: RelocationRun): Promise<void> {
  const record = run.current
  const { source } = record
  const outcome = await run.destinationStep(
    'prepare-destination',
    'relocate.prepare-destination',
    source.ownerEpoch + 1,
    {
      relocation: record.relocation,
      provider: record.provider,
      providerVersion: run.input.providerVersion,
      source: {
        hostId: source.hostId,
        conversationId: source.conversationId,
        ownerEpoch: source.ownerEpoch
      },
      workspace: run.input.workspace
    }
  )
  const stagingDir = resultField<string>(outcome, 'prepared', 'stagingDir')
  if (!stagingDir) {
    return await run.abandon(outcome, `${run.destination} is not ready to take it`)
  }
  record.stagingDir = stagingDir
  await run.save()
}

export async function freezeAndExportPhase(run: RelocationRun): Promise<void> {
  const record = run.current
  const payload = {
    relocation: record.relocation,
    provider: record.provider,
    destination: { hostId: record.destination.hostId }
  }
  if (!record.reservation) {
    const reserved = await run.step(
      'reserve-source',
      run.deps.source,
      'reserve',
      async () =>
        ({
          ...(await run.sourceTurn()),
          conversationId: record.source.conversationId,
          action: 'relocate.freeze-source',
          payload
        }) as RelocationStepRequest
    )
    if (UNANSWERED.has(reserved.kind)) {
      throw new RelocationStop(
        'blocked',
        `${run.source} did not answer whether it reserved the conversation, so nothing more was sent. Continue this move later.`,
        'host-unreachable'
      )
    }
    if (reserved.kind !== 'recorded' || reserved.operation.state !== 'admitted') {
      return await run.abandon(reserved, `${run.source} did not reserve it`)
    }
    record.reservation = reserved.operation.operationId
    await run.save()
  }
  const frozen = await run.sourceStep('freeze-source', 'relocate.freeze-source', payload)
  if (resultField<boolean>(frozen, 'frozen', 'frozen') !== true) {
    return await run.abandon(
      frozen,
      'it could not be stopped with proof that it and its child processes exited'
    )
  }
  const exported = await run.sourceStep('export', 'relocate.export', {
    relocation: record.relocation,
    provider: record.provider
  })
  const manifest = resultField<SessionHostRelocationManifest>(exported, 'exported', 'manifest')
  const exportDir = resultField<string>(exported, 'exported', 'exportDir')
  if (!manifest || !exportDir) {
    return await run.abandon(exported, 'its files could not be exported whole')
  }
  Object.assign(record, { manifest, exportDir })
  await run.save()
}

export async function copyAndStagePhase(run: RelocationRun): Promise<void> {
  const record = run.current
  try {
    await run.deps.channel.copy({
      source: run.deps.source,
      from: record.exportDir!,
      destination: run.deps.destination,
      to: record.stagingDir!,
      files: record.manifest!.files.map(({ path, bytes }) => ({ path, bytes })),
      relocation: record.relocation,
      conversationId: record.source.conversationId,
      provider: record.provider
    })
    noteRelocationStep(record, { step: 'copy', operationId: null, state: 'done' })
  } catch (error) {
    noteRelocationStep(record, {
      step: 'copy',
      operationId: null,
      state: 'failed',
      detail: error instanceof Error ? error.message : String(error)
    })
    return await run.abandon(null, `its files could not be copied to ${run.destination}`)
  }
  const staged = await run.destinationStep(
    'stage',
    'relocate.stage',
    record.source.ownerEpoch + 1,
    { relocation: record.relocation, provider: record.provider, manifest: record.manifest! }
  )
  if (resultField<boolean>(staged, 'ready', 'ready') !== true) {
    return await run.abandon(staged, `${run.destination} could not stage it whole`)
  }
  record.staged = true
  await run.save()
}

export async function relinquishPhase(run: RelocationRun): Promise<void> {
  const record = run.current
  const relinquished = await run.sourceStep('relinquish', 'relocate.relinquish', {
    relocation: record.relocation,
    provider: record.provider,
    destination: { hostId: record.destination.hostId },
    manifestDigest: record.manifest!.digest
  })
  const grant = resultField<SessionHostOwnershipGrant>(relinquished, 'relinquished', 'grant')
  if (!grant) {
    return await run.abandon(relinquished, `${run.source} did not hand it over`)
  }
  Object.assign(record, { grant, reservation: undefined, releasing: undefined })
  await run.save()
}

export async function resumePhase(
  run: RelocationRun,
  grant: SessionHostOwnershipGrant
): Promise<SessionRelocationResult> {
  const record = run.current
  const outcome = await run.destinationStep('resume', 'relocate.resume', grant.ownerEpoch, {
    relocation: record.relocation,
    provider: record.provider,
    grant
  })
  const handedOver = `${run.source} handed it over and never restarts it`
  if (UNANSWERED.has(outcome.kind)) {
    throw new RelocationStop(
      'blocked',
      `${run.destination} did not answer whether it resumed the conversation. ${handedOver}; continue this move later to find out.`,
      'host-unreachable'
    )
  }
  if (resultField<boolean>(outcome, 'resumed', 'resumed') === true) {
    await run.settle('relocated')
    return run.result(
      'relocated',
      `Moved the same conversation from ${run.source} to ${run.destination}; it resumed there under owner epoch ${grant.ownerEpoch}, confirmed by its provider. Its history on ${run.source} is kept.`
    )
  }
  if (outcome.kind === 'recorded' && outcome.operation.state === 'unconfirmed') {
    throw new RelocationStop(
      'owned-unconfirmed',
      `${run.destination} stopped before recording whether it took and started the conversation. ${handedOver}; check it on ${run.destination} before sending it anything.`
    )
  }
  const reason = resultField<string>(outcome, 'owned', 'reason')
  if (reason) {
    throw new RelocationStop(
      'owned-unconfirmed',
      `${run.destination} now owns the conversation, but: ${reason}`
    )
  }
  const refusal =
    outcome.kind === 'recorded'
      ? outcome.operation.refusal
      : 'refusal' in outcome
        ? outcome.refusal
        : undefined
  throw new RelocationStop(
    'blocked',
    `${run.destination} did not take the conversation (${refusal?.message ?? 'no answer'}). ${handedOver}; fix that and continue this move.`,
    refusal?.code
  )
}
