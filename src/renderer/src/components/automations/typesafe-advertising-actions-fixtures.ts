import type {
  AdvertisingDecisionEnvelope,
  BoundAdvertisingDecision
} from '../../../../shared/typesafe-advertising'
import type {
  ConsoleAdvertisingActionPreview,
  ConsoleAdvertisingActionReceipt
} from '../../../../shared/console-advertising-actions-contract'

export function makeAdvertisingDecision(
  overrides: Partial<BoundAdvertisingDecision> = {}
): BoundAdvertisingDecision {
  const timestamp = new Date().toISOString()
  const target: BoundAdvertisingDecision['target'] = {
    company: 'omnirogue',
    accountId: 'act_99999',
    objectType: 'adset',
    nativeId: '12345',
    campaignId: '54321',
    adsetId: '12345'
  }
  return {
    id: 'a'.repeat(64),
    target,
    kind: 'PAUSE',
    confidence: 0.93,
    probabilities: {
      KEEP_RUNNING: 0.2,
      TURN_ON: 0,
      PAUSE: 0.6,
      INCREASE_BUDGET: 0,
      DECREASE_BUDGET: 0.1,
      NO_ACTION: 0.1
    },
    evidence: {
      source: 'console.coordinator.statistics',
      target,
      name: 'Observed ad set',
      currency: 'USD',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      measuredAt: timestamp,
      fetchedAt: timestamp,
      dateStart: timestamp.slice(0, 10),
      dateStop: timestamp.slice(0, 10),
      timezone: 'UTC',
      leadEvent: 'lead',
      budgetOwnerId: '12345',
      limitations: [],
      metrics: {
        spend: 42,
        revenue: 0,
        purchases: 0,
        registrations: 0,
        leads: 0,
        addToCarts: 0,
        checkouts: 0,
        linkClicks: 5,
        impressions: 1000,
        dailyBudget: 50,
        linkCpc: 8.4,
        roas: 0
      }
    },
    evidenceRevision: 'd'.repeat(64),
    reasoningSummary: 'Review source performance.',
    parameters: { status: 'PAUSED' },
    requiresHumanApproval: true,
    recommendationOnly: false,
    verificationRequirements: ['Provider readback'],
    ...overrides
  }
}

export function makeAdvertisingEnvelope(
  overrides: Partial<AdvertisingDecisionEnvelope> = {}
): AdvertisingDecisionEnvelope {
  return {
    protocol: 'typesafe-advertising.v1',
    routineId: 'a-1',
    runId: 'run-1',
    evaluatedAt: Date.now(),
    principal: 'person-1',
    sourceRevision: 'e'.repeat(64),
    policy: {
      company: 'omnirogue',
      accountId: 'act_99999',
      allowedObjectTypes: ['adset', 'ad'],
      minConfidence: 0.8,
      maxEvidenceAgeSeconds: 300
    },
    status: 'ready',
    reason: null,
    provider: 'typesafe',
    model: 'evaluate',
    decisions: [makeAdvertisingDecision()],
    ...overrides
  }
}

export function makeAdvertisingPreview(
  overrides: Partial<ConsoleAdvertisingActionPreview> = {}
): ConsoleAdvertisingActionPreview {
  const now = Date.now()
  return {
    id: `act_${'b'.repeat(32)}`,
    protocol_version: 'human-action.v1',
    revision: 'c'.repeat(64),
    principal: 'person-1',
    service: null,
    actor_kind: 'human',
    target: { domain: 'advertising', company: 'omnirogue', type: 'adset', id: '12345' },
    verb: 'pause',
    expected_version: 'native-v1',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    undo_of: null,
    parameters: {},
    reason: 'Review source performance.',
    snapshot: {
      id: 'snapshot-1',
      objectId: '12345',
      adAccountId: 'act_99999',
      level: 'adset',
      parentId: '54321',
      campaignId: '54321',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: 50,
      lifetimeBudget: null,
      currency: 'USD',
      budgetOwnerId: '12345',
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
    evidence: {},
    ...overrides
  }
}

export function makeAdvertisingReceipt(
  status: ConsoleAdvertisingActionReceipt['status'] = 'accepted',
  overrides: Partial<ConsoleAdvertisingActionReceipt> = {}
): ConsoleAdvertisingActionReceipt {
  const preview = makeAdvertisingPreview()
  const verified = status === 'verified'
  return {
    id: preview.id,
    status,
    preview,
    execution: {
      idempotency_key: `tsa:${'a'.repeat(64)}`,
      requested_at: preview.created_at,
      dispatched_at: preview.created_at,
      completed_at: preview.created_at,
      outcome: { accepted: true, reference: 'native-action', result: {} },
      verification: {
        status: verified ? 'verified' : 'unknown',
        observed: verified
          ? { ...preview.snapshot, status: 'PAUSED', effectiveStatus: 'PAUSED' }
          : {},
        source: verified ? 'meta' : '',
        reference: verified ? 'native-action' : null,
        version: verified ? 'native-v2' : '',
        checked_at: preview.created_at
      }
    },
    ...overrides
  }
}
