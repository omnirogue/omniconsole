import type { BoundAdvertisingDecision } from '../../shared/typesafe-advertising'
import type {
  TypedAdvertisingActionPreview,
  TypedAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import type { AdvertisingActionBinding } from './typesafe-advertising-actions'

export function targetFor(decision: BoundAdvertisingDecision) {
  return {
    domain: 'advertising' as const,
    company: decision.target.company,
    type: decision.target.objectType,
    id: decision.target.nativeId
  }
}
export function verbFor(decision: BoundAdvertisingDecision): 'pause' | 'resume' {
  if (decision.kind === 'PAUSE') {
    return 'pause'
  }
  if (decision.kind === 'TURN_ON') {
    return 'resume'
  }
  throw new Error('This decision is recommendation-only; it cannot execute an advertising write.')
}

export function assertPreview(
  preview: TypedAdvertisingActionPreview,
  decision: BoundAdvertisingDecision
): void {
  const expected = decision.target
  const snapshot = preview.snapshot
  const transition = preview.transition
  const campaign = expected.objectType === 'campaign' ? snapshot.objectId : snapshot.campaignId
  const adset =
    expected.objectType === 'adset'
      ? snapshot.objectId
      : expected.objectType === 'ad'
        ? snapshot.parentId
        : null
  if (
    preview.target.domain !== 'advertising' ||
    preview.target.company !== expected.company ||
    preview.target.type !== expected.objectType ||
    preview.target.id !== expected.nativeId ||
    preview.verb !== verbFor(decision) ||
    Object.keys(preview.parameters).length !== 0 ||
    snapshot.objectId !== expected.nativeId ||
    snapshot.adAccountId !== expected.accountId ||
    snapshot.level !== expected.objectType ||
    campaign !== expected.campaignId ||
    adset !== expected.adsetId ||
    String(snapshot.status).toUpperCase() !== decision.evidence.status ||
    String(snapshot.effectiveStatus).toUpperCase() !== decision.evidence.effectiveStatus ||
    (decision.evidence.budgetOwnerId !== undefined &&
      snapshot.budgetOwnerId !== decision.evidence.budgetOwnerId) ||
    snapshot.currency !== decision.evidence.currency ||
    transition.field !== 'status' ||
    String(transition.from).toUpperCase() !== decision.evidence.status ||
    String(transition.to).toUpperCase() !== decision.parameters.status ||
    preview.risk.requires_confirmation !== true
  ) {
    throw new Error('The native preview does not match the reviewed advertising decision.')
  }
  if (
    decision.evidence.metrics.dailyBudget !== null &&
    (preview.financial_impact.daily_budget_ceiling === null
      ? null
      : Number(preview.financial_impact.daily_budget_ceiling)) !==
      decision.evidence.metrics.dailyBudget
  ) {
    throw new Error('The native daily budget changed; refresh the advertising recommendation.')
  }
}

export function assertReceipt(
  receipt: TypedAdvertisingActionReceipt,
  binding: AdvertisingActionBinding,
  decision: BoundAdvertisingDecision
): void {
  if (receipt.id !== binding.preview.id || receipt.preview.revision !== binding.preview.revision) {
    throw new Error('The recorded action does not match the approved native preview.')
  }
  if (receipt.status !== 'verified') {
    return
  }
  const verification = receipt.execution?.verification
  const observed = verification?.observed
  if (
    verification?.status !== 'verified' ||
    !verification.source ||
    !verification.version ||
    !observed ||
    observed.objectId !== decision.target.nativeId ||
    observed.adAccountId !== decision.target.accountId ||
    observed.level !== decision.target.objectType ||
    String(observed.status).toUpperCase() !== decision.parameters.status
  ) {
    throw new Error('The provider readback does not verify this exact advertising status change.')
  }
}
