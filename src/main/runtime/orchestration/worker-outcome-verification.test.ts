import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { readWorkerOutcomeReceipt } from './worker-outcome-receipt'
import { attachWorkerReceiptCanonicalReports } from './worker-outcome-verification'
import {
  canonicalReceiptBinding,
  canonicalReceiptLifecycle,
  createCanonicalReceiptDispatch
} from './worker-outcome-verification-test-fixture'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

function receipt() {
  return readWorkerOutcomeReceipt(db, createCanonicalReceiptDispatch(db).dispatch.id)
}

function observe(value: unknown) {
  const result = receipt()
  attachWorkerReceiptCanonicalReports(result, canonicalReceiptBinding, value)
  return result
}

describe('exact canonical historical report evidence', () => {
  it('exposes the exact report and frozen identities without quality or arbitrary findings', () => {
    const result = observe(canonicalReceiptLifecycle())
    expect(result.hubEvidence).toMatchObject({
      state: 'observed',
      canonicalReports: {
        scope: 'historical_attempt',
        attempt: {
          attemptId: canonicalReceiptBinding.attemptId,
          producingSessionIds: [canonicalReceiptBinding.sessionId],
          inputDigest: null,
          inputDigestProvenance: null,
          nativeExecutionRef: `foreman:${canonicalReceiptBinding.jobId}:1:${'a'.repeat(64)}`
        },
        reports: [{ reportId: 'ver_report1', verdict: 'pass', evidenceIds: ['ev_verifier1'] }]
      }
    })
    expect(result.outcome.independentlyAcceptedQuality).toBeNull()
    expect(JSON.stringify(result)).not.toContain('unselected-sensitive-findings')
  })

  it('keeps a historical pass separate from a changed current contract and task state', () => {
    const value = canonicalReceiptLifecycle()
    value.task.current_contract_id = 'contract_new'
    value.task.current_contract_digest = 'a'.repeat(64)
    value.task.current_contract_generation = 2
    value.task.lifecycle_generation = 2
    value.task.status = 'repair_required'
    const result = observe(value)
    expect(result.hubEvidence).toMatchObject({
      state: 'observed',
      canonicalReports: {
        attempt: { contractId: canonicalReceiptBinding.contractId, lifecycleGeneration: 1 },
        currentTask: { contractId: 'contract_new', lifecycleGeneration: 2 }
      }
    })
    expect(result.outcome).toMatchObject({
      independentlyAcceptedQuality: null,
      acceptanceReason: 'acceptance_not_observed'
    })
  })

  it.each(['fail', 'insufficient_evidence'])('preserves a canonical %s verdict', (verdict) => {
    const value = canonicalReceiptLifecycle()
    value.verification[0].verdict = verdict
    expect(observe(value).hubEvidence).toMatchObject({
      state: 'observed',
      canonicalReports: { reports: [{ verdict }] }
    })
  })

  it.each(['attempts', 'verification', 'evidence'])(
    'refuses degraded %s instead of a partial proof',
    (section) => {
      const value = canonicalReceiptLifecycle()
      value.degraded.push(section)
      expect(observe(value).hubEvidence).toEqual({
        state: 'unavailable',
        reason: 'canonical_report_projection_degraded'
      })
    }
  )

  it.each([
    { task: { id: canonicalReceiptBinding.taskId, verified_at: '2026-09-30T12:01:00Z' } },
    { ...canonicalReceiptLifecycle(), attempts: [] },
    { ...canonicalReceiptLifecycle(), verification: [] }
  ])('keeps missing or older projections unavailable: %#', (value) => {
    expect(observe(value).hubEvidence.state).toBe('unavailable')
  })

  it('does not trust canonical source on a legacy report row', () => {
    const value = canonicalReceiptLifecycle()
    value.verification[0].work_schema_version = 0
    expect(observe(value).hubEvidence).toEqual({
      state: 'unavailable',
      reason: 'canonical_report_contract_unavailable'
    })
  })

  it.each(['task_id', 'dispatch_key', 'contract_id', 'contract_digest'])(
    'rejects a foreign Attempt %s',
    (key) => {
      const value = canonicalReceiptLifecycle()
      Object.assign(value.attempts[0], {
        [key]: key.endsWith('digest') ? 'a'.repeat(64) : 'foreign'
      })
      expect(observe(value).hubEvidence).toEqual({
        state: 'unavailable',
        reason: 'canonical_attempt_binding_mismatch'
      })
    }
  )

  it('rejects a producer substitution', () => {
    const value = canonicalReceiptLifecycle()
    value.attempts[0].stints = [{ session_id: 'ses_other' }]
    expect(observe(value).hubEvidence.state).toBe('unavailable')
  })

  it('checks verifier independence against every complete producing stint', () => {
    const value = canonicalReceiptLifecycle()
    value.attempts[0].stints.push({ session_id: 'ses_verifier' })
    expect(observe(value).hubEvidence).toEqual({
      state: 'unavailable',
      reason: 'canonical_report_binding_mismatch'
    })
  })

  it.each(['task_id', 'contract_id', 'candidate_digest', 'evidence_manifest_digest'])(
    'refuses a report bound to another %s',
    (key) => {
      const value = canonicalReceiptLifecycle()
      Object.assign(value.verification[0], {
        [key]: key.endsWith('digest') ? 'a'.repeat(64) : 'foreign'
      })
      expect(observe(value).hubEvidence).toEqual({
        state: 'unavailable',
        reason: 'canonical_report_binding_mismatch'
      })
    }
  )

  it('never substitutes a same-task report for a different attempt', () => {
    const value = canonicalReceiptLifecycle()
    value.verification[0].attempt_id = 'att_unrelated'
    expect(observe(value).hubEvidence).toEqual({
      state: 'unavailable',
      reason: 'canonical_reports_unavailable'
    })
  })

  it.each([null, ['ev_good', null], ['ev_good', 'bad\nvalue'], []])(
    'refuses incomplete evidence IDs without filtering: %j',
    (ids) => {
      const value = canonicalReceiptLifecycle()
      Object.assign(value.verification[0], { evidence_ids: ids })
      expect(observe(value).hubEvidence).toEqual({
        state: 'unavailable',
        reason: 'canonical_report_contract_unavailable'
      })
    }
  )

  it('refuses missing report history instead of selecting a favorable pass', () => {
    const value = canonicalReceiptLifecycle()
    value.verification[0].report_ordinal = 2
    expect(observe(value).hubEvidence).toEqual({
      state: 'unavailable',
      reason: 'canonical_report_binding_mismatch'
    })
  })

  it('refuses oversized report lists instead of truncating', () => {
    const value = canonicalReceiptLifecycle()
    value.verification = Array.from({ length: 33 }, (_, index) => ({
      ...value.verification[0],
      id: `ver_${index}`,
      report_ordinal: index + 1
    }))
    expect(observe(value).hubEvidence).toEqual({
      state: 'unavailable',
      reason: 'canonical_report_limit_exceeded'
    })
  })

  it('refuses oversized producing stints instead of inferring verifier absence', () => {
    const value = canonicalReceiptLifecycle()
    value.attempts[0].stints = Array.from({ length: 257 }, (_, index) => ({
      session_id: `ses_${index}`
    }))
    expect(observe(value).hubEvidence).toEqual({
      state: 'unavailable',
      reason: 'canonical_attempt_contract_unavailable'
    })
  })
})
