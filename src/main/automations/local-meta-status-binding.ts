import {
  localAdvertisingActionPreview,
  type LocalAdvertisingActionPreview,
  type LocalAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import {
  advertisingDecisionEnvelope,
  boundAdvertisingDecision,
  type AdvertisingDecisionEnvelope,
  type BoundAdvertisingDecision
} from '../../shared/typesafe-advertising'
import type { LocalMetaActionScope } from './local-meta-action-authority'
import type { LocalMetaStatusObservation } from './local-meta-status-controls'
import { advertisingDigest, advertisingEvidenceRevision } from './typesafe-advertising-evidence'
import { assertPreview } from './typesafe-advertising-native-binding'

export type LocalMetaStatusContext = {
  decision: BoundAdvertisingDecision
  envelope: AdvertisingDecisionEnvelope
  scope: LocalMetaActionScope
  assertCurrent(): void | Promise<void>
}
export type LocalMetaStatusBinding = {
  preview: LocalAdvertisingActionPreview
  idempotencyKey: string
  submitted: boolean
  submittedAt?: string
  receipt: LocalAdvertisingActionReceipt | null
}

export function localPreviewRevision(preview: LocalAdvertisingActionPreview): string {
  const { revision: _revision, ...review } = localAdvertisingActionPreview.parse(preview)
  return advertisingDigest(review)
}

export function assertLocalStatusContext(context: LocalMetaStatusContext): void {
  const envelope = advertisingDecisionEnvelope.parse(context.envelope)
  const decision = boundAdvertisingDecision.parse(context.decision)
  const expectedStatus = decision.kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE'
  if (
    envelope.status !== 'ready' ||
    !envelope.decisions.some((item) => advertisingDigest(item) === advertisingDigest(decision)) ||
    decision.evidence.source !== 'local.meta.graph' ||
    advertisingEvidenceRevision(decision.evidence) !== decision.evidenceRevision ||
    !decision.requiresHumanApproval ||
    !decision.recommendationOnly ||
    !['PAUSE', 'TURN_ON'].includes(decision.kind) ||
    decision.parameters.status !== expectedStatus ||
    decision.evidence.status === expectedStatus ||
    decision.confidence < envelope.policy.minConfidence ||
    decision.target.company !== envelope.policy.company ||
    decision.target.accountId !== envelope.policy.accountId ||
    !envelope.policy.allowedObjectTypes.includes(decision.target.objectType) ||
    decision.target.objectType === 'campaign' ||
    advertisingDigest(decision.target) !== advertisingDigest(decision.evidence.target) ||
    context.scope.routineId !== envelope.routineId ||
    context.scope.runId !== envelope.runId ||
    advertisingDigest(context.scope.target) !== advertisingDigest(decision.target) ||
    !context.scope.isCurrent()
  ) {
    throw new Error('The local status action is outside the reviewed decision and owner scope.')
  }
}

export function assertLocalStatusObservation(
  context: LocalMetaStatusContext,
  observation: LocalMetaStatusObservation
): void {
  const { evidence } = context.decision
  if (
    observation.snapshot.status !== evidence.status ||
    observation.snapshot.effectiveStatus !== evidence.effectiveStatus ||
    observation.snapshot.currency !== evidence.currency ||
    observation.timezone !== evidence.timezone ||
    observation.dailyBudget !== evidence.metrics.dailyBudget ||
    observation.snapshot.budgetOwnerId !== evidence.budgetOwnerId
  ) {
    throw new Error('Local Meta native controls changed; refresh the recommendation.')
  }
}

export function assertLocalStatusBinding(
  context: LocalMetaStatusContext,
  binding: LocalMetaStatusBinding,
  authorityRevision: string
): LocalAdvertisingActionPreview {
  assertLocalStatusContext(context)
  const preview = localAdvertisingActionPreview.parse(binding.preview)
  const { envelope, decision } = context
  if (
    preview.principal !== envelope.principal ||
    preview.routine_id !== envelope.routineId ||
    preview.run_id !== envelope.runId ||
    preview.decision_id !== decision.id ||
    preview.source_revision !== envelope.sourceRevision ||
    preview.authority_revision !== authorityRevision ||
    preview.revision !== localPreviewRevision(preview) ||
    preview.expected_version !== advertisingDigest(preview.snapshot) ||
    Date.parse(preview.expires_at) - Date.parse(preview.created_at) > 120_000 ||
    binding.idempotencyKey !== `tsa:${decision.id}`
  ) {
    throw new Error('The local status preview no longer matches its reviewed authority and source.')
  }
  assertPreview(preview, decision)
  return preview
}
