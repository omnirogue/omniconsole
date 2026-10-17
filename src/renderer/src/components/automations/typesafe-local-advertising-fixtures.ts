import type {
  LocalAdvertisingActionPreview,
  LocalAdvertisingActionReceipt
} from '../../../../shared/advertising-action-provider-contract'
import {
  makeAdvertisingDecision,
  makeAdvertisingPreview
} from './typesafe-advertising-actions-fixtures'

export function makeLocalAdvertisingDecision(kind: 'PAUSE' | 'TURN_ON' = 'PAUSE') {
  const decision = makeAdvertisingDecision({ kind, recommendationOnly: true })
  decision.parameters.status = kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE'
  decision.evidence.status = kind === 'PAUSE' ? 'ACTIVE' : 'PAUSED'
  decision.evidence.effectiveStatus = decision.evidence.status
  decision.evidence.source = 'local.meta.graph'
  decision.evidence.measuredAt = null
  decision.evidence.observation = {
    freshnessBasis: 'completed_native_read',
    collectedAt: decision.evidence.fetchedAt,
    providerComputedAt: null,
    dayFinalized: false,
    attributionFinalized: false
  }
  return decision
}

export function makeLocalAdvertisingPreview(
  kind: 'PAUSE' | 'TURN_ON' = 'PAUSE'
): LocalAdvertisingActionPreview {
  const base = makeAdvertisingPreview()
  return {
    ...base,
    protocol_version: 'local-human-action.v1',
    provider: 'local.meta.graph',
    principal: 'person-1',
    service: null,
    actor_kind: 'human',
    routine_id: 'a-1',
    run_id: 'run-1',
    decision_id: 'a'.repeat(64),
    source_revision: 'e'.repeat(64),
    authority_revision: 'f'.repeat(64),
    expected_version: '1'.repeat(64),
    target: { ...base.target, type: 'adset' },
    verb: kind === 'PAUSE' ? 'pause' : 'resume',
    undo_of: null,
    snapshot: {
      ...base.snapshot,
      level: 'adset',
      parentId: '54321',
      campaignId: '54321',
      status: kind === 'PAUSE' ? 'ACTIVE' : 'PAUSED',
      effectiveStatus: kind === 'PAUSE' ? 'ACTIVE' : 'PAUSED',
      currency: 'USD',
      dailyBudget: 5000,
      lifetimeBudget: null,
      budgetOwnerId: '12345',
      ancestors: [
        {
          objectId: '54321',
          adAccountId: 'act_99999',
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
      from: kind === 'PAUSE' ? 'active' : 'paused',
      to: kind === 'PAUSE' ? 'paused' : 'active'
    },
    authority: { revision: 'f'.repeat(64), details: {} },
    risk: { action_class: 'external_reversible', requires_confirmation: true },
    financial_impact: { ...base.financial_impact, currency: 'USD', daily_budget_ceiling: 50 },
    undo: { requires_new_approval: true },
    evidence: { source: 'local.meta.graph' }
  }
}

export function makeLocalAdvertisingReceipt(
  verified = false,
  kind: 'PAUSE' | 'TURN_ON' = 'PAUSE'
): LocalAdvertisingActionReceipt {
  const preview = makeLocalAdvertisingPreview(kind)
  return {
    id: preview.id,
    provider: 'local.meta.graph',
    status: verified ? 'verified' : 'unverified',
    preview,
    execution: {
      idempotency_key: `tsa:${'a'.repeat(64)}`,
      requested_at: preview.created_at,
      dispatched_at: preview.created_at,
      completed_at: preview.created_at,
      outcome: null,
      verification: {
        status: verified ? 'verified' : 'unknown',
        claim: 'target_state_observed',
        causality: 'unproven',
        observed: verified
          ? {
              ...preview.snapshot,
              status: kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE',
              effectiveStatus: kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE'
            }
          : null,
        source: 'local.meta.graph',
        reference: null,
        version: verified ? '2'.repeat(64) : null,
        checked_at: preview.created_at
      }
    }
  }
}
