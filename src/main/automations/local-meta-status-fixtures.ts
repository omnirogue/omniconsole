import { vi } from 'vitest'
import type { LocalAdvertisingActionPreview } from '../../shared/advertising-action-provider-contract'
import { authorizeLocalMetaAction } from './local-meta-action-authority'
import { advertisingDigest, advertisingEvidenceRevision } from './typesafe-advertising-evidence'
import { advertisingTestEnvelope } from './typesafe-advertising-fixtures'
import { fetchLocalMetaEvidence } from './typesafe-advertising-local-meta-evidence'
import { OLDACS_ROUTINE_ID } from './typesafe-advertising-local-scope'
import type { prepareLocalStatusPreview } from './local-meta-status-provider'
import { META_NOW, metaFixture, metaTarget, mockMetaFetch } from './local-meta-fixtures'

export function mockLocalStatusAuthority() {
  const authority = {
    token: 'fixture-only-status-token',
    revision: 'a'.repeat(64),
    isCurrent: vi.fn(() => true),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(() => {})
  }
  vi.mocked(authorizeLocalMetaAction).mockResolvedValue(authority)
  return authority
}

export async function localStatusFixture(
  type: 'ad' | 'adset' = 'adset',
  kind: 'PAUSE' | 'TURN_ON' = 'PAUSE'
) {
  const fixture = metaFixture()
  const target = metaTarget(type)
  if (kind === 'TURN_ON') {
    fixture[type].status = 'PAUSED'
    fixture[type].effective_status = 'PAUSED'
  }
  const [evidence] = await fetchLocalMetaEvidence(
    [target],
    { token: 'fixture-only-status-token', isCurrent: () => true },
    { fetch: mockMetaFetch(fixture), now: () => META_NOW }
  )
  const envelope = advertisingTestEnvelope()
  envelope.routineId = OLDACS_ROUTINE_ID
  envelope.runId = 'local-status-fixture-run'
  envelope.evaluatedAt = META_NOW
  envelope.policy.accountId = target.accountId
  envelope.sourceRevision = advertisingDigest(evidence)
  const decision = envelope.decisions[0]
  Object.assign(decision, {
    target,
    kind,
    evidence,
    evidenceRevision: advertisingEvidenceRevision(evidence),
    parameters: { status: kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE' },
    recommendationOnly: true,
    probabilities: {
      KEEP_RUNNING: 0,
      TURN_ON: kind === 'TURN_ON' ? 1 : 0,
      PAUSE: kind === 'PAUSE' ? 1 : 0,
      INCREASE_BUDGET: 0,
      DECREASE_BUDGET: 0,
      NO_ACTION: 0
    }
  })
  const context: Parameters<typeof prepareLocalStatusPreview>[0] = {
    decision,
    envelope,
    scope: {
      routineId: envelope.routineId,
      runId: envelope.runId,
      target,
      isCurrent: vi.fn(() => true)
    },
    assertCurrent: vi.fn(async () => {})
  }
  const reads = mockMetaFetch(fixture)
  const behavior = {
    applyStatus: true,
    postFailure: false,
    malformedRead: false,
    onGet: () => {},
    afterPost: () => {}
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (init?.method === 'POST') {
      if (behavior.postFailure) {
        throw new Error('Fixture connection lost after submission.')
      }
      if (behavior.applyStatus) {
        const status = new URLSearchParams(String(init.body)).get('status')
        fixture[type].status = status
        fixture[type].effective_status = status
      }
      behavior.afterPost()
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    behavior.onGet()
    if (behavior.malformedRead) {
      return new Response('{not-json', { status: 200 })
    }
    return reads(input, init)
  })
  let clock = META_NOW
  return {
    fixture,
    context,
    fetch,
    behavior,
    options: { fetch, now: () => clock },
    setTime(value: number) {
      clock = value
    },
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  }
}

export function submittedLocalBinding(preview: LocalAdvertisingActionPreview) {
  return {
    preview,
    idempotencyKey: `tsa:${preview.decision_id}`,
    submitted: true,
    submittedAt: preview.created_at,
    receipt: null
  }
}
