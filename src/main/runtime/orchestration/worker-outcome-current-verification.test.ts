import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { readWorkerOutcomeReceipt } from './worker-outcome-receipt'
import { attachWorkerReceiptCanonicalReports } from './worker-outcome-verification'
import {
  canonicalReceiptBinding,
  canonicalReceiptCurrentVerification,
  canonicalReceiptLifecycle,
  createCanonicalReceiptDispatch
} from './worker-outcome-verification-test-fixture'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

function lifecycle(currentVerification: unknown = canonicalReceiptCurrentVerification()) {
  return { ...canonicalReceiptLifecycle(), current_verification: currentVerification }
}

function receipt() {
  return readWorkerOutcomeReceipt(db, createCanonicalReceiptDispatch(db).dispatch.id)
}

function observe(value: unknown) {
  const result = receipt()
  attachWorkerReceiptCanonicalReports(result, canonicalReceiptBinding, value)
  return result
}

describe('authoritative current accepted report evidence', () => {
  it('matches the view-selected report to exact independent evidence without a quality score', () => {
    const result = observe(lifecycle())
    expect(result.hubEvidence.state).toBe('observed')
    expect(result.outcome).toMatchObject({
      independentlyAcceptedQuality: null,
      acceptanceReason: 'quality_not_measured',
      currentAcceptance: {
        state: 'observed',
        source: 'hub-task-lifecycle',
        authorityView: 'canonical_current_task_verifications',
        reportId: 'ver_report1',
        verificationPolicyDigest: 'b'.repeat(64)
      }
    })
    expect(JSON.stringify(result)).not.toContain('unselected-sensitive-findings')
  })

  it('keeps old-HUB absence unavailable even when historical pass and task status exist', () => {
    const result = observe(canonicalReceiptLifecycle())
    expect(result.hubEvidence.state).toBe('observed')
    expect(result.outcome).toMatchObject({
      acceptanceReason: 'acceptance_not_observed',
      currentAcceptance: {
        state: 'unavailable',
        reason: 'canonical_current_verification_unavailable'
      }
    })
  })

  it('distinguishes a healthy null selector from an unavailable view', () => {
    expect(observe(lifecycle(null)).outcome).toMatchObject({
      independentlyAcceptedQuality: null,
      acceptanceReason: 'acceptance_not_observed',
      currentAcceptance: { state: 'not_observed', reason: 'canonical_current_verification_absent' }
    })
  })

  it.each([null, canonicalReceiptCurrentVerification()])(
    'refuses a degraded current view with selector %j',
    (selector) => {
      const value = lifecycle(selector)
      value.degraded.push('current_verification')
      const result = observe(value)
      expect(result.hubEvidence.state).toBe('observed')
      expect(result.outcome.currentAcceptance).toEqual({
        state: 'unavailable',
        reason: 'canonical_current_verification_degraded'
      })
    }
  )

  it.each([
    { source: 'derived' },
    { authority_view: 'task_status' },
    { verification_report_id: null },
    { candidate_generation: 0 }
  ])('refuses incomplete or unsupported current selectors: %j', (fields) => {
    expect(
      observe(lifecycle({ ...canonicalReceiptCurrentVerification(), ...fields })).outcome
        .currentAcceptance
    ).toEqual({
      state: 'unavailable',
      reason: 'canonical_current_verification_contract_unavailable'
    })
  })

  it.each([
    { task_id: 'task_other' },
    { attempt_id: 'att_other' },
    { verification_report_id: 'ver_other' },
    { contract_id: 'contract_other' },
    { contract_digest: 'a'.repeat(64) },
    { contract_generation: 2 },
    { candidate_generation: 2 }
  ])('refuses a current selector for another binding: %j', (fields) => {
    const result = observe(lifecycle({ ...canonicalReceiptCurrentVerification(), ...fields }))
    expect(result.hubEvidence.state).toBe('observed')
    expect(result.outcome).toMatchObject({
      independentlyAcceptedQuality: null,
      acceptanceReason: 'acceptance_not_observed',
      currentAcceptance: {
        state: 'unavailable',
        reason: 'canonical_current_verification_binding_mismatch'
      }
    })
  })

  it('keeps a frozen historical report when the selector conflicts with the current contract', () => {
    const value = lifecycle()
    value.task.current_contract_digest = 'a'.repeat(64)
    const result = observe(value)
    expect(result.hubEvidence.state).toBe('observed')
    expect(result.outcome.currentAcceptance?.state).toBe('unavailable')
  })

  it.each(['fail', 'insufficient_evidence'])(
    'does not promote a selected historical %s report to acceptance',
    (verdict) => {
      const value = lifecycle()
      value.verification[0].verdict = verdict
      const result = observe(value)
      expect(result.hubEvidence.state).toBe('observed')
      expect(result.outcome.currentAcceptance?.state).toBe('unavailable')
      expect(result.outcome.independentlyAcceptedQuality).toBeNull()
    }
  )

  it('cannot bypass independent producer verification with a view selector', () => {
    const value = lifecycle()
    value.attempts[0].stints.push({ session_id: 'ses_verifier' })
    const result = observe(value)
    expect(result.hubEvidence.state).toBe('unavailable')
    expect(result.outcome.currentAcceptance?.state).toBe('unavailable')
  })

  it('refuses ambiguous report identity without discarding the validated history', () => {
    const value = lifecycle()
    value.verification.push({ ...value.verification[0], report_ordinal: 2 })
    const result = observe(value)
    expect(result.hubEvidence.state).toBe('observed')
    expect(result.outcome.currentAcceptance?.state).toBe('unavailable')
  })

  it('clears a previous observation when the next complete view has no current report', () => {
    const result = receipt()
    attachWorkerReceiptCanonicalReports(result, canonicalReceiptBinding, lifecycle())
    expect(result.outcome.currentAcceptance?.state).toBe('observed')
    attachWorkerReceiptCanonicalReports(result, canonicalReceiptBinding, lifecycle(null))
    expect(result.outcome.currentAcceptance?.state).toBe('not_observed')
    expect(result.outcome.acceptanceReason).toBe('acceptance_not_observed')
  })

  it('clears a previous observation when the exact attempt becomes unverifiable', () => {
    const result = receipt()
    attachWorkerReceiptCanonicalReports(result, canonicalReceiptBinding, lifecycle())
    expect(result.outcome.currentAcceptance?.state).toBe('observed')
    attachWorkerReceiptCanonicalReports(result, canonicalReceiptBinding, {
      ...lifecycle(),
      attempts: []
    })
    expect(result.hubEvidence.state).toBe('unavailable')
    expect(result.outcome.currentAcceptance?.state).toBe('unavailable')
    expect(result.outcome.acceptanceReason).toBe('acceptance_not_observed')
  })
})
