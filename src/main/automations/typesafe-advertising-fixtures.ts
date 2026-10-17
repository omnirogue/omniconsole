import type {
  AdvertisingDecisionEnvelope,
  AdvertisingEvidence,
  AdvertisingRoutinePolicy
} from '../../shared/typesafe-advertising'
import type {
  ConsoleAdvertisingActionPreview,
  ConsoleAdvertisingActionReceipt
} from '../../shared/console-advertising-actions-contract'
import { advertisingDigest, advertisingEvidenceRevision } from './typesafe-advertising-evidence'

export const advertisingTestPolicy: AdvertisingRoutinePolicy = {
  company: 'omnirogue',
  accountId: 'act_123456',
  allowedObjectTypes: ['adset', 'ad'],
  minConfidence: 0.8,
  maxEvidenceAgeSeconds: 300
}
export const advertisingTestLocalObservation = {
  freshnessBasis: 'completed_native_read',
  collectedAt: '2026-09-20T12:00:00+00:00',
  providerComputedAt: null,
  dayFinalized: false,
  attributionFinalized: false
} as const
export const advertisingTestEvidence: AdvertisingEvidence = {
  source: 'console.coordinator.statistics',
  target: {
    company: 'omnirogue',
    accountId: 'act_123456',
    objectType: 'adset',
    nativeId: '123457',
    campaignId: '123458',
    adsetId: '123457'
  },
  name: 'Observed ad set',
  currency: 'USD',
  status: 'ACTIVE',
  effectiveStatus: 'ACTIVE',
  measuredAt: '2026-09-20T12:00:00+00:00',
  fetchedAt: '2026-09-20T12:00:00+00:00',
  dateStart: '2026-09-20',
  dateStop: '2026-09-20',
  timezone: 'UTC',
  leadEvent: 'lead',
  budgetOwnerId: '123457',
  limitations: [],
  metrics: {
    spend: 42,
    revenue: 0,
    purchases: 0,
    registrations: 0,
    leads: 0,
    addToCarts: null,
    checkouts: 0,
    linkClicks: 5,
    impressions: 1000,
    dailyBudget: 50,
    linkCpc: 8.4,
    roas: 0
  }
}
export function advertisingTestEnvelope(): AdvertisingDecisionEnvelope {
  const evidence = structuredClone(advertisingTestEvidence)
  return {
    protocol: 'typesafe-advertising.v1',
    routineId: 'routine-1',
    runId: 'run-1',
    evaluatedAt: Date.parse(evidence.fetchedAt),
    principal: 'person-1',
    sourceRevision: advertisingDigest(evidence),
    policy: { ...advertisingTestPolicy },
    status: 'ready',
    reason: null,
    provider: 'typesafe',
    model: 'evaluate',
    decisions: [
      {
        id: '1'.repeat(64),
        target: evidence.target,
        kind: 'PAUSE',
        confidence: 0.9,
        probabilities: {
          KEEP_RUNNING: 0,
          TURN_ON: 0,
          PAUSE: 1,
          INCREASE_BUDGET: 0,
          DECREASE_BUDGET: 0,
          NO_ACTION: 0
        },
        evidence,
        evidenceRevision: advertisingEvidenceRevision(evidence),
        reasoningSummary: 'Review source performance.',
        parameters: { status: 'PAUSED' },
        requiresHumanApproval: true,
        recommendationOnly: false,
        verificationRequirements: ['Provider readback']
      }
    ]
  }
}
export function advertisingTestPreview(): ConsoleAdvertisingActionPreview {
  return {
    id: `act_${'a'.repeat(32)}`,
    protocol_version: 'human-action.v1',
    revision: '2'.repeat(64),
    principal: 'human-1',
    service: null,
    actor_kind: 'human',
    target: { domain: 'advertising', company: 'omnirogue', type: 'adset', id: '123457' },
    verb: 'pause',
    expected_version: 'native-version',
    created_at: '2026-09-20T12:00:00+00:00',
    expires_at: '2026-09-20T12:10:00+00:00',
    undo_of: null,
    parameters: {},
    reason: 'Review source performance.',
    snapshot: {
      id: 'internal-1',
      objectId: '123457',
      adAccountId: 'act_123456',
      level: 'adset',
      parentId: '123458',
      campaignId: '123458',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: 50,
      lifetimeBudget: null,
      currency: 'USD',
      budgetOwnerId: '123457',
      ancestors: []
    },
    transition: { field: 'status', from: 'active', to: 'paused' },
    authority: { revision: 'authority-1', details: {} },
    risk: { action_class: 'external_reversible', requires_confirmation: true },
    summary: 'Pause Observed ad set',
    financial_impact: {
      currency: 'USD',
      profit_effect: 'unproven',
      daily_budget_ceiling: 50,
      basis: 'Budget ceiling only'
    },
    undo: {},
    evidence: {}
  }
}
export function advertisingTestReceipt(): ConsoleAdvertisingActionReceipt {
  const preview = advertisingTestPreview()
  return {
    id: preview.id,
    status: 'verified',
    preview,
    execution: {
      idempotency_key: `tsa:${'1'.repeat(64)}`,
      requested_at: preview.created_at,
      dispatched_at: preview.created_at,
      completed_at: preview.created_at,
      outcome: { accepted: true, reference: 'native-action', result: {} },
      verification: {
        status: 'verified',
        observed: { ...preview.snapshot, status: 'PAUSED' },
        source: 'Meta native read via ApexLabs governor',
        version: 'native-version-2',
        reference: 'native-action',
        checked_at: preview.created_at
      }
    }
  }
}
