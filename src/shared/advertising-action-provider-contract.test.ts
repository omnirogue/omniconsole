import { describe, expect, it } from 'vitest'
import {
  localAdvertisingActionPreview,
  localAdvertisingActionReceipt,
  localAdvertisingActionSnapshot,
  localAdvertisingActionVerification,
  typedAdvertisingActionPreview,
  typedAdvertisingActionReceipt,
  type LocalAdvertisingActionPreview,
  type LocalAdvertisingActionReceipt,
  type LocalAdvertisingActionSnapshot
} from './advertising-action-provider-contract'
import {
  advertisingActionPreview,
  advertisingActionReceipt,
  type AdvertisingActionPreview,
  type AdvertisingActionReceipt
} from './console-advertising-actions-contract'

const createdAt = '2026-09-20T12:00:00+00:00'
const checkedAt = '2026-09-20T12:00:10+00:00'
const revision = (digit: string) => digit.repeat(64)

function snapshot(level: 'adset' | 'ad' = 'adset'): LocalAdvertisingActionSnapshot {
  const campaign = {
    objectId: '123450',
    adAccountId: 'act_123456',
    level: 'campaign' as const,
    parentId: null,
    campaignId: null,
    status: 'ACTIVE' as const,
    effectiveStatus: 'ACTIVE',
    dailyBudget: 5000,
    lifetimeBudget: null
  }
  return {
    id: 'local-native-snapshot',
    objectId: level === 'ad' ? '123452' : '123451',
    adAccountId: campaign.adAccountId,
    level,
    parentId: level === 'ad' ? '123451' : campaign.objectId,
    campaignId: campaign.objectId,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    dailyBudget: null,
    lifetimeBudget: null,
    currency: 'USD',
    budgetOwnerId: campaign.objectId,
    ancestors: [
      campaign,
      ...(level === 'ad'
        ? [
            {
              ...campaign,
              objectId: '123451',
              level: 'adset' as const,
              parentId: campaign.objectId,
              campaignId: campaign.objectId,
              dailyBudget: null
            }
          ]
        : [])
    ]
  }
}

function preview(
  verb: 'pause' | 'resume' = 'pause',
  level: 'adset' | 'ad' = 'adset'
): LocalAdvertisingActionPreview {
  const native = snapshot(level)
  native.status = verb === 'pause' ? 'ACTIVE' : 'PAUSED'
  native.effectiveStatus = native.status
  return {
    id: `act_${'a'.repeat(32)}`,
    protocol_version: 'local-human-action.v1',
    provider: 'local.meta.graph',
    revision: revision('1'),
    principal: 'synthetic-human',
    service: null,
    actor_kind: 'human',
    routine_id: 'synthetic-routine',
    run_id: 'synthetic-run',
    decision_id: revision('2'),
    source_revision: revision('3'),
    authority_revision: revision('4'),
    target: { domain: 'advertising', company: 'omnirogue', type: level, id: native.objectId },
    verb,
    expected_version: revision('5'),
    created_at: createdAt,
    expires_at: '2026-09-20T12:10:00+00:00',
    undo_of: null,
    parameters: {},
    reason: 'Synthetic status-only recommendation.',
    snapshot: native,
    transition: {
      field: 'status',
      from: verb === 'pause' ? 'active' : 'paused',
      to: verb === 'pause' ? 'paused' : 'active'
    },
    authority: { revision: revision('4'), details: {} },
    risk: { action_class: 'external_reversible', requires_confirmation: true },
    summary: 'Review the exact native status transition.',
    financial_impact: {
      currency: 'USD',
      profit_effect: 'unproven',
      daily_budget_ceiling: 50,
      basis: 'Existing campaign budget ceiling; not a spending or profit prediction.'
    },
    undo: { requires_new_approval: true },
    evidence: { source: 'local.meta.graph' }
  }
}

function receipt(verb: 'pause' | 'resume' = 'pause', level: 'adset' | 'ad' = 'adset') {
  const proposal = preview(verb, level)
  const observed = structuredClone(proposal.snapshot)
  observed.status = verb === 'pause' ? 'PAUSED' : 'ACTIVE'
  observed.effectiveStatus = observed.status
  return {
    id: proposal.id,
    provider: 'local.meta.graph',
    status: 'verified',
    preview: proposal,
    execution: {
      idempotency_key: `local:${revision('6')}`,
      requested_at: createdAt,
      dispatched_at: createdAt,
      completed_at: checkedAt,
      outcome: { accepted: true, reference: null },
      verification: {
        status: 'verified',
        claim: 'target_state_observed',
        causality: 'unproven',
        observed,
        source: 'local.meta.graph',
        reference: null,
        version: revision('7'),
        checked_at: checkedAt
      }
    }
  } satisfies LocalAdvertisingActionReceipt
}

function backendPreview(): AdvertisingActionPreview {
  const local = preview()
  return {
    id: local.id,
    protocol_version: 'human-action.v1',
    revision: local.revision,
    principal: local.principal,
    service: null,
    actor_kind: 'human',
    target: local.target,
    verb: local.verb,
    expected_version: 'backend-native-version',
    created_at: local.created_at,
    expires_at: local.expires_at,
    undo_of: null,
    parameters: {},
    reason: local.reason,
    snapshot: local.snapshot,
    transition: local.transition,
    authority: { revision: 'backend-authority', details: { policy: 'existing' } },
    risk: local.risk,
    summary: local.summary,
    financial_impact: local.financial_impact,
    undo: {},
    evidence: { source: 'existing backend' }
  }
}

function backendReceipt(): AdvertisingActionReceipt {
  const proposal = backendPreview()
  return {
    id: proposal.id,
    status: 'verified',
    preview: proposal,
    execution: {
      idempotency_key: `backend:${revision('8')}`,
      requested_at: createdAt,
      dispatched_at: createdAt,
      completed_at: checkedAt,
      outcome: { accepted: true, reference: 'backend-reference', result: {} },
      verification: {
        status: 'verified',
        observed: { status: 'PAUSED' },
        source: 'Existing backend native read',
        reference: null,
        version: 'backend-native-version-2',
        checked_at: checkedAt
      }
    }
  }
}

describe('local human status-only advertising contracts', () => {
  it.each([
    ['pause', 'adset'],
    ['resume', 'adset'],
    ['pause', 'ad'],
    ['resume', 'ad']
  ] as const)('accepts a bounded %s proposal and observed receipt for an %s', (verb, level) => {
    const proposal = preview(verb, level)
    const result = receipt(verb, level)
    expect(localAdvertisingActionPreview.parse(proposal)).toEqual(proposal)
    expect(typedAdvertisingActionPreview.parse(proposal)).toEqual(proposal)
    expect(localAdvertisingActionReceipt.parse(result)).toEqual(result)
    expect(typedAdvertisingActionReceipt.parse(result)).toEqual(result)
    expect(result.execution.verification.causality).toBe('unproven')
    expect(advertisingActionPreview.safeParse(proposal).success).toBe(false)
    expect(advertisingActionReceipt.safeParse(result).success).toBe(false)
  })

  const invalidPreviews: [string, (value: LocalAdvertisingActionPreview) => unknown][] = [
    ['unknown provider', (value) => ({ ...value, provider: 'another.provider' })],
    ['backend protocol', (value) => ({ ...value, protocol_version: 'human-action.v1' })],
    ['fake signature', (value) => ({ ...value, signature: 'not-a-backend-signature' })],
    ['service actor', (value) => ({ ...value, actor_kind: 'service' })],
    ['service identity', (value) => ({ ...value, service: 'scheduler' })],
    ['campaign target', (value) => ({ ...value, target: { ...value.target, type: 'campaign' } })],
    ['budget verb', (value) => ({ ...value, verb: 'increase_budget' })],
    ['budget parameter', (value) => ({ ...value, parameters: { daily_budget: 9000 } })],
    ['arbitrary URL', (value) => ({ ...value, parameters: { url: 'https://example.invalid' } })],
    ['different object', (value) => ({ ...value, target: { ...value.target, id: '999999' } })],
    ['different level', (value) => ({ ...value, target: { ...value.target, type: 'ad' } })],
    [
      'wrong initial state',
      (value) => ({ ...value, transition: { ...value.transition, from: 'paused' } })
    ],
    [
      'unchanged transition',
      (value) => ({ ...value, transition: { ...value.transition, to: 'active' } })
    ],
    [
      'wrong status field',
      (value) => ({ ...value, transition: { ...value.transition, field: 'budget' } })
    ],
    ['authority revision drift', (value) => ({ ...value, authority_revision: revision('9') })],
    [
      'malformed source revision',
      (value) => ({ ...value, source_revision: 'prose is not a revision' })
    ],
    [
      'authority expansion',
      (value) => ({ ...value, authority: { ...value.authority, details: { all: true } } })
    ],
    [
      'unconfirmed action',
      (value) => ({ ...value, risk: { ...value.risk, requires_confirmation: false } })
    ],
    [
      'profit claim',
      (value) => ({
        ...value,
        financial_impact: { ...value.financial_impact, profit_effect: 'proven' }
      })
    ],
    [
      'currency drift',
      (value) => ({ ...value, financial_impact: { ...value.financial_impact, currency: 'EUR' } })
    ],
    ['automatic undo', (value) => ({ ...value, undo: { requires_new_approval: false } })],
    ['backend evidence', (value) => ({ ...value, evidence: { source: 'signed.backend' } })],
    ['nonpositive expiry', (value) => ({ ...value, expires_at: value.created_at })]
  ]
  it.each(invalidPreviews)(
    'rejects %s without reinterpreting it as signed authority',
    (_name, edit) => {
      const candidate = edit(preview())
      expect(localAdvertisingActionPreview.safeParse(candidate).success).toBe(false)
      expect(typedAdvertisingActionPreview.safeParse(candidate).success).toBe(false)
    }
  )

  const invalidSnapshots: [string, (value: LocalAdvertisingActionSnapshot) => unknown][] = [
    ['missing ancestor', (value) => ({ ...value, ancestors: [] })],
    [
      'foreign account',
      (value) => ({
        ...value,
        ancestors: value.ancestors.map((item) => ({ ...item, adAccountId: 'act_999999' }))
      })
    ],
    ['wrong campaign', (value) => ({ ...value, campaignId: '999999' })],
    ['wrong parent', (value) => ({ ...value, parentId: '999999' })],
    [
      'nested campaign',
      (value) => ({
        ...value,
        ancestors: value.ancestors.map((item) => ({ ...item, parentId: '999999' }))
      })
    ],
    ['foreign budget owner', (value) => ({ ...value, budgetOwnerId: '999999' })],
    ['fractional minor units', (value) => ({ ...value, dailyBudget: 12.5 })],
    ['negative budget', (value) => ({ ...value, lifetimeBudget: -1 })],
    ['unsafe budget integer', (value) => ({ ...value, dailyBudget: Number.MAX_SAFE_INTEGER + 1 })],
    ['unrecognized native status', (value) => ({ ...value, status: 'DELETED' })],
    ['extra snapshot authority', (value) => ({ ...value, approved: true })]
  ]
  it.each(invalidSnapshots)('rejects an invalid native snapshot: %s', (_name, edit) => {
    expect(localAdvertisingActionSnapshot.safeParse(edit(snapshot())).success).toBe(false)
  })

  it('requires the exact ordered campaign and ad set ancestors for an ad', () => {
    const native = snapshot('ad')
    expect(
      localAdvertisingActionSnapshot.safeParse({ ...native, budgetOwnerId: native.objectId })
        .success
    ).toBe(false)
    expect(
      localAdvertisingActionSnapshot.safeParse({ ...native, ancestors: [native.ancestors[0]] })
        .success
    ).toBe(false)
    expect(
      localAdvertisingActionSnapshot.safeParse({
        ...native,
        ancestors: native.ancestors.toReversed()
      }).success
    ).toBe(false)
    expect(
      localAdvertisingActionSnapshot.safeParse({
        ...native,
        ancestors: native.ancestors.map((item) =>
          item.level === 'adset' ? { ...item, campaignId: '999999' } : item
        )
      }).success
    ).toBe(false)
  })
})

describe('independent native verification is observation, not proof of causality', () => {
  it.each(['pending', 'unknown', 'mismatch'] as const)(
    'retains %s as unverified with no fabricated observation',
    (status) => {
      const result = receipt()
      const verification = {
        ...result.execution.verification,
        status,
        observed: null,
        version: null
      }
      expect(localAdvertisingActionVerification.parse(verification)).toEqual(verification)
      const candidate = {
        ...result,
        status: 'unverified',
        execution: { ...result.execution, verification }
      }
      expect(localAdvertisingActionReceipt.parse(candidate)).toEqual(candidate)
    }
  )

  it.each([
    { observed: null },
    { version: null },
    { causality: 'proven' },
    { claim: 'action_caused_change' },
    { source: 'assistant prose' },
    { signed: true }
  ])('refuses a fabricated verification claim: %j', (patch) => {
    const result = receipt()
    const verification = { ...result.execution.verification, ...patch }
    expect(localAdvertisingActionVerification.safeParse(verification).success).toBe(false)
    expect(
      localAdvertisingActionReceipt.safeParse({
        ...result,
        execution: { ...result.execution, verification }
      }).success
    ).toBe(false)
  })

  const observedChanges: [
    string,
    (value: LocalAdvertisingActionSnapshot) => LocalAdvertisingActionSnapshot
  ][] = [
    ['different object', (value) => ({ ...value, objectId: '999999' })],
    [
      'different account',
      (value) => ({
        ...value,
        adAccountId: 'act_999999',
        ancestors: value.ancestors.map((item) => ({ ...item, adAccountId: 'act_999999' }))
      })
    ],
    ['wrong target status', (value) => ({ ...value, status: 'ACTIVE', effectiveStatus: 'ACTIVE' })],
    ['changed own budget', (value) => ({ ...value, dailyBudget: 1 })],
    ['changed lifetime budget', (value) => ({ ...value, lifetimeBudget: 1 })],
    ['changed currency', (value) => ({ ...value, currency: 'EUR' })],
    ['changed budget owner', (value) => ({ ...value, budgetOwnerId: value.objectId })],
    [
      'changed ancestor budget',
      (value) => ({
        ...value,
        ancestors: value.ancestors.map((item) => ({ ...item, dailyBudget: 9000 }))
      })
    ],
    [
      'changed ancestor status',
      (value) => ({
        ...value,
        ancestors: value.ancestors.map((item) => ({ ...item, status: 'PAUSED' }))
      })
    ],
    [
      'changed ancestor effective status',
      (value) => ({
        ...value,
        ancestors: value.ancestors.map((item) => ({ ...item, effectiveStatus: 'PAUSED' }))
      })
    ],
    [
      'changed campaign hierarchy',
      (value) => ({
        ...value,
        parentId: '999999',
        campaignId: '999999',
        budgetOwnerId: '999999',
        ancestors: value.ancestors.map((item) => ({ ...item, objectId: '999999' }))
      })
    ]
  ]
  it.each(observedChanges)('refuses verified state with %s', (_name, edit) => {
    const result = receipt()
    result.execution.verification.observed = edit(result.execution.verification.observed)
    expect(
      localAdvertisingActionSnapshot.safeParse(result.execution.verification.observed).success
    ).toBe(true)
    expect(localAdvertisingActionReceipt.safeParse(result).success).toBe(false)
    expect(typedAdvertisingActionReceipt.safeParse(result).success).toBe(false)
  })

  it('requires a receipt, verification and preview with matching identities and status', () => {
    const result = receipt()
    for (const candidate of [
      { ...result, id: `act_${'b'.repeat(32)}` },
      { ...result, provider: 'signed.backend' },
      { ...result, execution: null },
      { ...result, execution: { ...result.execution, verification: null } },
      {
        ...result,
        execution: {
          ...result.execution,
          verification: { ...result.execution.verification, status: 'pending' }
        }
      },
      { ...result, status: 'accepted' },
      { ...result, signed: true }
    ]) {
      expect(localAdvertisingActionReceipt.safeParse(candidate).success).toBe(false)
      expect(typedAdvertisingActionReceipt.safeParse(candidate).success).toBe(false)
    }
  })

  it('does not claim a matching state proves our request caused the change', () => {
    const result = receipt()
    const parsed = localAdvertisingActionReceipt.parse({
      ...result,
      execution: { ...result.execution, outcome: { ...result.execution.outcome, accepted: false } }
    })
    expect(parsed.execution?.verification?.claim).toBe('target_state_observed')
    expect(parsed.execution?.verification?.causality).toBe('unproven')
    expect(parsed.execution?.outcome?.accepted).toBe(false)
  })
})

describe('existing signed backend contracts remain a distinct provider', () => {
  it('accepts the untouched backend preview and receipt through the generic contract', () => {
    const proposal = backendPreview()
    const result = backendReceipt()
    expect(typedAdvertisingActionPreview.parse(proposal)).toEqual(
      advertisingActionPreview.parse(proposal)
    )
    expect(typedAdvertisingActionReceipt.parse(result)).toEqual(
      advertisingActionReceipt.parse(result)
    )
    expect(localAdvertisingActionPreview.safeParse(proposal).success).toBe(false)
    expect(localAdvertisingActionReceipt.safeParse(result).success).toBe(false)
  })

  it('retains expired backend receipts without inventing a local authority binding', () => {
    const proposal = backendPreview()
    const expired = {
      id: proposal.id,
      protocol_version: proposal.protocol_version,
      revision: proposal.revision,
      principal: proposal.principal,
      service: proposal.service,
      actor_kind: proposal.actor_kind,
      target: proposal.target,
      verb: proposal.verb,
      expected_version: proposal.expected_version,
      created_at: proposal.created_at,
      expires_at: proposal.expires_at,
      undo_of: proposal.undo_of,
      details_expired: true
    }
    const result = { id: proposal.id, status: 'unverified', preview: expired, execution: null }
    expect(advertisingActionPreview.safeParse(expired).success).toBe(false)
    expect(typedAdvertisingActionReceipt.parse(result)).toEqual(
      advertisingActionReceipt.parse(result)
    )
  })

  it('rejects provider and protocol collisions instead of stripping local markers', () => {
    const proposal = backendPreview()
    const result = backendReceipt()
    for (const candidate of [
      { ...proposal, provider: 'local.meta.graph' },
      { ...proposal, provider: 'unknown' },
      { ...proposal, authority_revision: revision('4') },
      { ...proposal, source_revision: revision('3') },
      { ...proposal, protocol_version: 'local-human-action.v1' }
    ]) {
      expect(typedAdvertisingActionPreview.safeParse(candidate).success).toBe(false)
    }
    for (const candidate of [
      { ...result, provider: 'local.meta.graph' },
      { ...result, provider: 'unknown' },
      { ...result, preview: { ...proposal, authority_revision: revision('4') } },
      { ...result, preview: { ...proposal, source_revision: revision('3') } },
      { ...result, preview: { ...proposal, provider: 'local.meta.graph' } }
    ]) {
      expect(typedAdvertisingActionReceipt.safeParse(candidate).success).toBe(false)
    }
  })
})
