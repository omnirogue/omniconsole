import { randomUUID } from 'node:crypto'
import {
  localAdvertisingActionPreview,
  localAdvertisingActionReceipt,
  type LocalAdvertisingActionPreview,
  type LocalAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import { authorizeLocalMetaAction } from './local-meta-action-authority'
import {
  assertLocalStatusBinding,
  assertLocalStatusContext,
  assertLocalStatusObservation,
  localPreviewRevision,
  type LocalMetaStatusBinding,
  type LocalMetaStatusContext
} from './local-meta-status-binding'
import { localMetaStatusMatches, readLocalMetaStatus } from './local-meta-status-controls'
import { createLocalMetaStatusWriter } from './local-meta-status-transport'
import { advertisingDigest, assertAdvertisingEvidenceFresh } from './typesafe-advertising-evidence'
import type { LocalMetaReaderOptions } from './typesafe-advertising-local-meta-transport'
import { targetFor, verbFor } from './typesafe-advertising-native-binding'

export type { LocalMetaStatusBinding, LocalMetaStatusContext } from './local-meta-status-binding'
type LocalExecution = NonNullable<LocalAdvertisingActionReceipt['execution']>

async function captureOperation(context: LocalMetaStatusContext) {
  assertLocalStatusContext(context)
  await context.assertCurrent()
  const fingerprint = advertisingDigest([context.envelope, context.decision])
  const authority = await authorizeLocalMetaAction(
    context.scope,
    context.envelope.policy,
    context.envelope.principal
  )
  const isCurrent = () => {
    try {
      authority.assertCurrentSync()
      return (
        authority.isCurrent() &&
        context.scope.isCurrent() &&
        fingerprint === advertisingDigest([context.envelope, context.decision])
      )
    } catch {
      return false
    }
  }
  const assertCurrent = async () => {
    await context.assertCurrent()
    await authority.assertCurrent()
    assertLocalStatusContext(context)
    if (!isCurrent()) {
      throw new Error('The reviewed local status action or its authority changed.')
    }
  }
  await assertCurrent()
  return { token: authority.token, revision: authority.revision, isCurrent, assertCurrent }
}

export async function prepareLocalStatusPreview(
  context: LocalMetaStatusContext,
  options: LocalMetaReaderOptions = {}
): Promise<LocalAdvertisingActionPreview> {
  const identity = await captureOperation(context)
  const now = options.now ?? Date.now
  assertAdvertisingEvidenceFresh(context.decision.evidence, context.envelope.policy, now())
  const observation = await readLocalMetaStatus(context.decision.target, identity, options)
  assertLocalStatusObservation(context, observation)
  await identity.assertCurrent()
  const time = now()
  const { decision, envelope } = context
  const preview = localAdvertisingActionPreview.parse({
    id: `act_${randomUUID().replaceAll('-', '')}`,
    protocol_version: 'local-human-action.v1',
    provider: 'local.meta.graph',
    revision: '0'.repeat(64),
    principal: envelope.principal,
    service: null,
    actor_kind: 'human',
    routine_id: envelope.routineId,
    run_id: envelope.runId,
    decision_id: decision.id,
    source_revision: envelope.sourceRevision,
    authority_revision: identity.revision,
    target: targetFor(decision),
    verb: verbFor(decision),
    expected_version: observation.version,
    created_at: new Date(time).toISOString(),
    expires_at: new Date(time + 120_000).toISOString(),
    undo_of: null,
    parameters: {},
    reason: decision.reasoningSummary,
    snapshot: observation.snapshot,
    transition: {
      field: 'status',
      from: observation.snapshot.status.toLowerCase(),
      to: decision.parameters.status?.toLowerCase()
    },
    authority: { revision: identity.revision, details: {} },
    risk: { action_class: 'external_reversible', requires_confirmation: true },
    summary: `${decision.kind === 'PAUSE' ? 'Pause' : 'Turn on'} this exact ${decision.target.objectType} at its existing native budget.`,
    financial_impact: {
      currency: observation.snapshot.currency,
      profit_effect: 'unproven',
      daily_budget_ceiling: observation.dailyBudget,
      basis:
        'Existing native budget only; ancestor budgets may be shared. Delivery and profit effects are unproven.'
    },
    undo: { requires_new_approval: true },
    evidence: { source: 'local.meta.graph' }
  })
  preview.revision = localPreviewRevision(preview)
  return preview
}

function submittedExecution(binding: LocalMetaStatusBinding): LocalExecution {
  const submittedTime = Date.parse(binding.submittedAt ?? '')
  if (
    !binding.submitted ||
    !binding.submittedAt ||
    !Number.isFinite(submittedTime) ||
    new Date(submittedTime).toISOString() !== binding.submittedAt
  ) {
    throw new Error('The local action has no durable recorded submission to execute or verify.')
  }
  if (binding.receipt?.execution) {
    const receipt = localAdvertisingActionReceipt.parse(binding.receipt)
    if (
      receipt.id !== binding.preview.id ||
      receipt.preview.revision !== binding.preview.revision ||
      receipt.execution?.idempotency_key !== binding.idempotencyKey ||
      receipt.execution.requested_at !== binding.submittedAt
    ) {
      throw new Error('The local action receipt does not match its recorded submission.')
    }
    return receipt.execution
  }
  return {
    idempotency_key: binding.idempotencyKey,
    requested_at: binding.submittedAt,
    dispatched_at: null,
    completed_at: null,
    outcome: null,
    verification: null
  }
}

async function observeReceipt(
  context: LocalMetaStatusContext,
  binding: LocalMetaStatusBinding,
  execution: LocalExecution,
  identity: Awaited<ReturnType<typeof captureOperation>>,
  options: LocalMetaReaderOptions
): Promise<LocalAdvertisingActionReceipt> {
  const observed = await readLocalMetaStatus(context.decision.target, identity, options)
  await identity.assertCurrent()
  const desired = binding.preview.transition.to === 'active' ? 'ACTIVE' : 'PAUSED'
  const verified = localMetaStatusMatches(binding.preview.snapshot, observed.snapshot, desired)
  return localAdvertisingActionReceipt.parse({
    id: binding.preview.id,
    provider: 'local.meta.graph',
    status: verified ? 'verified' : 'unverified',
    preview: binding.preview,
    execution: {
      ...execution,
      verification: {
        status: verified ? 'verified' : 'mismatch',
        claim: 'target_state_observed',
        causality: 'unproven',
        observed: observed.snapshot,
        source: 'local.meta.graph',
        reference: execution.outcome?.reference ?? null,
        version: observed.version,
        checked_at: observed.observedAt
      }
    }
  })
}

export async function executeLocalStatus(
  context: LocalMetaStatusContext,
  binding: LocalMetaStatusBinding,
  options: LocalMetaReaderOptions = {}
): Promise<LocalAdvertisingActionReceipt> {
  const identity = await captureOperation(context)
  const preview = assertLocalStatusBinding(context, binding, identity.revision)
  const execution = submittedExecution(binding)
  const now = options.now ?? Date.now
  assertAdvertisingEvidenceFresh(context.decision.evidence, context.envelope.policy, now())
  if (Date.parse(preview.expires_at) <= now() || Date.parse(preview.created_at) > now()) {
    throw new Error('The local status preview expired; review a new preview.')
  }
  const latest = await readLocalMetaStatus(context.decision.target, identity, options)
  assertLocalStatusObservation(context, latest)
  if (latest.version !== preview.expected_version) {
    throw new Error('Local Meta native controls changed after approval; no status write was sent.')
  }
  await identity.assertCurrent()
  if (Date.parse(preview.expires_at) <= now()) {
    throw new Error('The local status preview expired before dispatch; no status write was sent.')
  }
  const desired = preview.transition.to === 'active' ? 'ACTIVE' : 'PAUSED'
  execution.dispatched_at = new Date(now()).toISOString()
  const writeIdentity = {
    ...identity,
    isCurrent: () => {
      try {
        if (!identity.isCurrent()) {
          return false
        }
        const time = now()
        assertAdvertisingEvidenceFresh(context.decision.evidence, context.envelope.policy, time)
        return Date.parse(preview.created_at) <= time && Date.parse(preview.expires_at) > time
      } catch {
        return false
      }
    }
  }
  try {
    const result = await createLocalMetaStatusWriter(writeIdentity, options).send(
      context.decision.target,
      desired
    )
    execution.completed_at = result.respondedAt
    execution.outcome = { accepted: result.accepted, reference: result.reference }
    return await observeReceipt(context, binding, execution, identity, options)
  } catch {
    throw new Error(
      'The local status action is unconfirmed. Verify its recorded state; do not resend it.'
    )
  }
}

/** Recovery observes the exact native state; it never repeats a submitted write. */
export async function verifyLocalStatus(
  context: LocalMetaStatusContext,
  binding: LocalMetaStatusBinding,
  options: LocalMetaReaderOptions = {}
): Promise<LocalAdvertisingActionReceipt> {
  const identity = await captureOperation(context)
  assertLocalStatusBinding(context, binding, identity.revision)
  const execution = submittedExecution(binding)
  try {
    return await observeReceipt(context, binding, execution, identity, options)
  } catch {
    throw new Error('The local status action could not be verified; it will not be resent.')
  }
}
