import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAuditPipelineProbe } from '../../../../../config/scripts/workflows/probe-audit-pipeline'
import { AUDIT_FIXTURE_REVISION } from '../../../../../config/scripts/workflows/fixtures/audit-pipeline-fixture'
import type { runAuditProgram } from './audit-program'
import { auditSurvival } from './audit-review'
import type { AuditEvidencePacket } from './audit-source-store'
import type { AuditEvidenceStatus } from './audit-evidence'
import type { AuditFinding } from '../../../../shared/workflow-audit-contracts'
import { summarizeAuditAgreement } from '../../../../shared/workflow-audit-validation'

describe('audit program on the durable workflow service', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-program-'))
  let report: Awaited<ReturnType<typeof runAuditPipelineProbe>>
  let result: Awaited<ReturnType<typeof runAuditProgram>>
  beforeAll(async () => {
    report = await runAuditPipelineProbe(join(root, 'probe'))
    expect(report.outcome.error).toBeUndefined()
    expect(report.outcome.state).toBe('completed')
    result = report.outcome.result as Awaited<ReturnType<typeof runAuditProgram>>
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('covers every disjoint source and preserves quote provenance through hierarchy', () => {
    expect(result.sourceCount).toBe(2)
    expect(result.readersCompleted).toBe(2)
    expect(result.readersExpected).toBe(2)
    expect(result.readers.flatMap((reader) => reader.sourceIds)).toEqual([
      'fixture-studio-1',
      'fixture-macbook-2'
    ])
    const repeated = result.reviewed.find((finding) => finding.id === 'T-repeat')!
    expect(repeated.evidence).toHaveLength(4)
    expect(repeated.evidenceCount).toBe(2)
    expect(repeated.disposition).toBe('survived')
    expect(repeated.status).toBe('unknown')
  })

  it('drops fabricated evidence even when the model lenses incorrectly confirm it', () => {
    const fabricated = result.reviewed.find((finding) => finding.id === 'T-fabricated')!
    expect(fabricated.verification.evidence.verdict).toBe('confirmed')
    expect(fabricated.sourceCheck.check.citations[0].status).toBe('quote-not-found')
    expect(fabricated.evidenceCount).toBe(0)
    expect(fabricated.disposition).toBe('dropped')
    expect(
      result.plans.every((plan) =>
        plan.initiatives.every(
          (initiative) =>
            initiative.themeIds.includes('T-repeat') &&
            !initiative.themeIds.includes('T-fabricated')
        )
      )
    ).toBe(true)
  })

  it('keeps empty novelty valid and computes sampled agreement and judge totals', () => {
    expect(result.novelty).toHaveLength(1)
    expect(result.novelty[0].findings).toEqual([])
    expect(result.agreement).toHaveLength(1)
    expect(result.agreement[0].agreementRate).toBe(1)
    expect(result.winners).toEqual(['Plan B'])
    expect(result.tally.find((row) => row.label === 'Plan B')?.total).toBe(72)
    expect(result.judgements[0].route).toBe('generative')
    expect(result.judgements[0].reason).toBe('missing-redaction')
  })

  it('applies the completeness revision and replays without sources or new processes', () => {
    expect(result.revised).toBe(true)
    expect(result.final.markdown).toBe(AUDIT_FIXTURE_REVISION)
    expect(report.calls).toHaveLength(23)
    expect(new Set(report.calls).size).toBe(23)
    expect(report.externalLaunches).toBe(23)
    expect(report.attempts).toBe(23)
    expect(report.uniqueExternalIds).toBe(23)
    expect(report.sourceRemovedBeforeReplay).toBe(true)
    expect(report.replayMatches).toBe(true)
  })
})

describe('audit survival boundaries', () => {
  const confirmed = {
    version: 1 as const,
    verdict: 'confirmed' as const,
    reason: 'Evidence supports it'
  }
  const packet = (status: AuditEvidenceStatus): AuditEvidencePacket => ({
    excerpts: [],
    check: {
      citations: [{ sourceId: 'fixture', quote: 'quote', status }],
      citedSourceCount: 1,
      verifiedSourceCount: status === 'verified' ? 1 : 0,
      allVerified: status === 'verified'
    }
  })
  it('withholds unavailable evidence rather than treating missing contact as a refutation', () => {
    for (const status of [
      'source-missing',
      'source-unreadable',
      'source-changed',
      'source-id-mismatch'
    ] as const) {
      expect(auditSurvival(packet(status), confirmed, confirmed)).toBe('unverified')
    }
    expect(auditSurvival(packet('verified'), { ...confirmed, verdict: 'unknown' }, confirmed)).toBe(
      'unverified'
    )
  })
  it('drops a disproven quote or a refuted impact assessment', () => {
    expect(auditSurvival(packet('quote-not-found'), confirmed, confirmed)).toBe('dropped')
    expect(auditSurvival(packet('verified'), confirmed, { ...confirmed, verdict: 'refuted' })).toBe(
      'dropped'
    )
  })
})

describe('audit agreement counts', () => {
  it('counts distinct matched findings for many-to-many pairs and permits unequal reader counts', () => {
    const finding = (id: string): AuditFinding => ({
      id,
      title: id,
      description: id,
      evidence: [],
      impact: 1,
      proposedFix: id
    })
    const a = ['a1', 'a2', 'a3', 'a4'].map(finding)
    const b = ['b1', 'b2', 'b3'].map(finding)
    const summary = summarizeAuditAgreement(
      {
        version: 1,
        matches: [
          { aId: 'a1', bId: 'b1', reason: 'Pair one' },
          { aId: 'a1', bId: 'b2', reason: 'Pair two' },
          { aId: 'a2', bId: 'b2', reason: 'Pair three' },
          { aId: 'a3', bId: 'b3', reason: 'Pair four' },
          { aId: 'a4', bId: 'b3', reason: 'Pair five' }
        ]
      },
      a,
      b
    )

    expect(summary).toEqual({
      aTotal: 4,
      bTotal: 3,
      aMatched: 4,
      bMatched: 3,
      agreementRate: 1,
      onlyA: [],
      onlyB: []
    })
    expect(summarizeAuditAgreement({ version: 1, matches: [] }, [], []).agreementRate).toBeNull()
  })
})
