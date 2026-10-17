import type {
  LocalAdvertisingActionPreview,
  LocalAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import type { AdvertisingDecisionEnvelope } from '../../shared/typesafe-advertising'
import type { AdvertisingActionBinding } from './typesafe-advertising-actions'
import { advertisingDigest, advertisingEvidenceRevision } from './typesafe-advertising-evidence'
import {
  advertisingTestEnvelope,
  advertisingTestLocalObservation,
  advertisingTestPreview
} from './typesafe-advertising-fixtures'
import { OLDACS_ACCOUNT_ID, OLDACS_ROUTINE_ID } from './typesafe-advertising-local-scope'

export function localActionEnvelope(
  kind: 'PAUSE' | 'TURN_ON' = 'PAUSE'
): AdvertisingDecisionEnvelope {
  const envelope = advertisingTestEnvelope()
  envelope.routineId = OLDACS_ROUTINE_ID
  envelope.policy.accountId = OLDACS_ACCOUNT_ID
  const decision = envelope.decisions[0]
  decision.target.accountId = OLDACS_ACCOUNT_ID
  decision.evidence.source = 'local.meta.graph'
  decision.evidence.measuredAt = null
  decision.evidence.observation = { ...advertisingTestLocalObservation }
  decision.kind = kind
  decision.parameters.status = kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE'
  decision.evidence.status = kind === 'PAUSE' ? 'ACTIVE' : 'PAUSED'
  decision.evidence.effectiveStatus = decision.evidence.status
  decision.evidenceRevision = advertisingEvidenceRevision(decision.evidence)
  decision.recommendationOnly = true
  decision.probabilities.PAUSE = kind === 'PAUSE' ? 1 : 0
  decision.probabilities.TURN_ON = kind === 'TURN_ON' ? 1 : 0
  envelope.sourceRevision = advertisingDigest(decision.evidence)
  return envelope
}

export function localActionPreview(
  envelope = localActionEnvelope()
): LocalAdvertisingActionPreview {
  const base = advertisingTestPreview()
  const decision = envelope.decisions[0]
  const preview: LocalAdvertisingActionPreview = {
    ...base,
    id: `act_${decision.id.slice(0, 32)}`,
    protocol_version: 'local-human-action.v1',
    provider: 'local.meta.graph',
    principal: envelope.principal,
    service: null,
    actor_kind: 'human',
    routine_id: envelope.routineId,
    run_id: envelope.runId,
    decision_id: decision.id,
    source_revision: envelope.sourceRevision,
    authority_revision: '3'.repeat(64),
    target: {
      domain: 'advertising',
      company: decision.target.company,
      type: 'adset',
      id: decision.target.nativeId
    },
    verb: decision.kind === 'PAUSE' ? 'pause' : 'resume',
    expected_version: '4'.repeat(64),
    created_at: new Date(base.created_at).toISOString(),
    expires_at: new Date(base.expires_at).toISOString(),
    undo_of: null,
    snapshot: {
      id: `local.meta.graph:adset:${decision.target.nativeId}`,
      objectId: decision.target.nativeId,
      adAccountId: decision.target.accountId,
      level: 'adset',
      parentId: decision.target.campaignId,
      campaignId: decision.target.campaignId,
      status: decision.kind === 'PAUSE' ? 'ACTIVE' : 'PAUSED',
      effectiveStatus: decision.evidence.effectiveStatus,
      dailyBudget: 5000,
      lifetimeBudget: null,
      currency: 'USD',
      budgetOwnerId: decision.target.nativeId,
      ancestors: [
        {
          objectId: decision.target.campaignId,
          adAccountId: decision.target.accountId,
          level: 'campaign',
          parentId: null,
          campaignId: null,
          status: 'ACTIVE',
          effectiveStatus: 'ACTIVE',
          dailyBudget: null,
          lifetimeBudget: null
        }
      ]
    },
    transition: {
      field: 'status',
      from: decision.kind === 'PAUSE' ? 'active' : 'paused',
      to: decision.kind === 'PAUSE' ? 'paused' : 'active'
    },
    authority: { revision: '3'.repeat(64), details: {} },
    risk: { action_class: 'external_reversible', requires_confirmation: true },
    financial_impact: { ...base.financial_impact, currency: 'USD', daily_budget_ceiling: 50 },
    undo: { requires_new_approval: true },
    evidence: { source: 'local.meta.graph' }
  }
  const { revision: _revision, ...review } = preview
  preview.revision = advertisingDigest(review)
  return preview
}

export function localActionReceipt(preview = localActionPreview()): LocalAdvertisingActionReceipt {
  return {
    id: preview.id,
    provider: 'local.meta.graph',
    status: 'verified',
    preview,
    execution: {
      idempotency_key: `tsa:${preview.decision_id}`,
      requested_at: preview.created_at,
      dispatched_at: preview.created_at,
      completed_at: preview.created_at,
      outcome: { accepted: true, reference: null },
      verification: {
        status: 'verified',
        claim: 'target_state_observed',
        causality: 'unproven',
        observed: {
          ...preview.snapshot,
          status: preview.verb === 'pause' ? 'PAUSED' : 'ACTIVE',
          effectiveStatus: preview.verb === 'pause' ? 'PAUSED' : 'ACTIVE'
        },
        source: 'local.meta.graph',
        reference: null,
        version: '5'.repeat(64),
        checked_at: preview.created_at
      }
    }
  }
}

export function localActionBinding(envelope = localActionEnvelope()): AdvertisingActionBinding & {
  preview: LocalAdvertisingActionPreview
  receipt: LocalAdvertisingActionReceipt | null
} {
  return {
    automationId: envelope.routineId,
    runId: envelope.runId,
    decisionId: envelope.decisions[0].id,
    principal: envelope.principal,
    sourceRevision: envelope.sourceRevision,
    idempotencyKey: `tsa:${envelope.decisions[0].id}`,
    preview: localActionPreview(envelope),
    submitted: false,
    receipt: null
  }
}
