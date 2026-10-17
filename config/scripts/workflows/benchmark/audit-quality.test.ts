import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAuditQuality } from './audit-quality-run'
import {
  auditQualityScore,
  type AuditAdjudication,
  type AuditQualityTrial
} from './audit-quality-score'

describe('audit paired quality instrument', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-quality-'))
  const output = join(directory, 'comparison')
  let result: Awaited<ReturnType<typeof runAuditQuality>>
  beforeAll(async () => {
    result = await runAuditQuality({ directory: output, mode: 'fixture', repetitions: 2 })
  })
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it('runs all routes on identical evidence with balanced order and preserves the direct champion', () => {
    expect(result.trials.map((trial) => trial.arm)).toEqual([
      'direct',
      'reader-merge',
      'full',
      'reader-merge',
      'full',
      'direct'
    ])
    expect(new Set(result.trials.map((trial) => trial.inputHash)).size).toBe(1)
    expect(result.trials.every((trial) => trial.state === 'completed')).toBe(true)
    expect(result.trials.map((trial) => trial.resources.attempts)).toEqual([1, 4, 23, 4, 23, 1])
    expect(JSON.parse(readFileSync(join(output, 'direct-champion-1.json'), 'utf8'))).toEqual(
      result.trials[0].answer
    )
    expect(result.trials[0].quoteChecks).toContainEqual({
      findingId: 'T-repeat',
      allVerified: true,
      distinctSources: 2
    })
    expect(result.trials[0].quoteChecks).toContainEqual({
      findingId: 'T-fabricated',
      allVerified: false,
      distinctSources: 0
    })
  })

  it('keeps unlabelled quality, provider tokens and price unknown', () => {
    expect(result.report.quality).toBe('unknown-awaiting-independent-labels')
    expect(result.report.pairedUsefulDeltas).toBeNull()
    expect(
      result.report.arms.every(
        (arm) =>
          arm.tokens === null && arm.costUsd === null && arm.usefulDistinctMechanisms === null
      )
    ).toBe(true)
    const pending = JSON.parse(
      readFileSync(join(output, 'adjudications.pending.json'), 'utf8')
    ) as AuditAdjudication[]
    expect(
      pending.every(
        (label) => !label.independent && label.findings.every((finding) => finding.valid === null)
      )
    ).toBe(true)
  })

  it('exports blind packets without the route map, role metadata or a prior score', () => {
    const packets = JSON.parse(readFileSync(join(output, 'blind-packets.json'), 'utf8')) as Record<
      string,
      unknown
    >[]
    expect(
      packets.every(
        (packet) => Object.keys(packet).sort().join(',') === 'failed,findings,markdown,sampleId'
      )
    ).toBe(true)
    expect(JSON.stringify(packets)).not.toContain('disposition')
    expect(JSON.parse(readFileSync(join(output, 'private-route-map.json'), 'utf8'))).toHaveLength(6)
  })

  it('refuses implicit live configuration and existing output directories', async () => {
    await expect(
      runAuditQuality({ directory: join(directory, 'live'), mode: 'live', repetitions: 1 })
    ).rejects.toThrow('explicit pinned Claude model')
    await expect(
      runAuditQuality({ directory: output, mode: 'fixture', repetitions: 1 })
    ).rejects.toThrow('new output directory')
  })
})

function trials(): AuditQualityTrial[] {
  return (['direct', 'reader-merge', 'full'] as const).map((arm) => ({
    sampleId: arm,
    arm,
    repetition: 1,
    inputHash: 'same-frozen-inputs',
    mode: 'live',
    state: 'completed',
    error: null,
    answer: {
      markdown: 'Proposal',
      raw: null,
      findings: ['a', 'b'].map((id) => ({
        id,
        title: id,
        description: id,
        evidence: [{ sourceId: 'source', quote: 'quote' }],
        impact: 3,
        proposedFix: id
      }))
    },
    quoteChecks: [
      { findingId: 'a', allVerified: true, distinctSources: 1 },
      { findingId: 'b', allVerified: true, distinctSources: 1 }
    ],
    resources: { attempts: 2, wallClockMs: 10, tokens: null, costUsd: null, modelIds: [] }
  }))
}
function labels(rows: AuditQualityTrial[]): AuditAdjudication[] {
  return rows.map((row) => ({
    sampleId: row.sampleId,
    assessor: 'Independent fixture reviewer',
    independent: true,
    evidenceRef: 'fixture-review',
    findings: row.answer!.findings.map((finding) => ({
      findingId: finding.id,
      valid: true,
      useful: true,
      novel: true,
      mechanismId: 'same-mechanism'
    }))
  }))
}

describe('audit quality scoring', () => {
  it('counts externally accepted distinct mechanisms, not copied findings or raw agreement', () => {
    const rows = trials()
    const report = auditQualityScore(rows, labels(rows), 1)
    expect(report.arms.map((arm) => arm.usefulDistinctMechanisms?.mean)).toEqual([1, 1, 1])
    expect(report.pairedUsefulDeltas?.map((arm) => arm.byRepetition)).toEqual([[0], [0]])
  })
  it('requires external labels even when every quoted string is present', () => {
    const rows = trials()
    const assessments = labels(rows)
    assessments[0].findings[0].valid = null
    expect(auditQualityScore(rows, assessments, 1).quality).toBe(
      'unknown-awaiting-independent-labels'
    )
    assessments[0].findings[0].valid = true
    assessments[0].independent = false
    expect(auditQualityScore(rows, assessments, 1).pairedUsefulDeltas).toBeNull()
  })
  it('does not promote invalid quotes or fixture results into measured model quality', () => {
    const rows = trials()
    rows[0].quoteChecks.forEach((check) => {
      check.allVerified = false
    })
    rows.forEach((row) => {
      row.mode = 'fixture'
    })
    const report = auditQualityScore(rows, labels(rows), 1)
    expect(report.quality).toBe('fixture-behavior-only')
    expect(report.arms[0].usefulDistinctMechanisms?.mean).toBe(0)
  })
  it('refuses missing trials, changed evidence, and duplicate or incomplete adjudications', () => {
    const rows = trials()
    expect(() => auditQualityScore(rows.slice(1), [], 1)).toThrow('Incomplete preregistered')
    expect(() => auditQualityScore(rows, [], 2)).toThrow('Incomplete preregistered')
    rows[0].inputHash = 'changed'
    expect(() => auditQualityScore(rows, [], 1)).toThrow('identical frozen inputs')
    rows[0].inputHash = rows[1].inputHash
    const assessments = labels(rows)
    expect(() => auditQualityScore(rows, [...assessments, assessments[0]], 1)).toThrow(
      'duplicate or unknown'
    )
    assessments[0].findings.pop()
    expect(() => auditQualityScore(rows, assessments, 1)).toThrow('exactly once')
  })
  it('retains failed runs in overhead and requires their separate adjudication record', () => {
    const rows = trials()
    rows[2] = {
      ...rows[2],
      state: 'failed',
      error: 'Provider unavailable',
      answer: null,
      quoteChecks: []
    }
    const assessments = labels(rows.slice(0, 2))
    expect(auditQualityScore(rows, assessments, 1).quality).toBe(
      'unknown-awaiting-independent-labels'
    )
    assessments.push({
      sampleId: rows[2].sampleId,
      assessor: 'Reviewer',
      independent: true,
      evidenceRef: 'failure receipt',
      findings: []
    })
    const report = auditQualityScore(rows, assessments, 1)
    expect(report.arms[2].failed).toBe(1)
    expect(report.arms[2].attempts.mean).toBe(2)
    expect(report.arms[2].usefulDistinctMechanisms?.mean).toBe(0)
  })
  it('scores a failed trial as zero despite an apparently useful partial answer', () => {
    const rows = trials()
    rows[2].state = 'failed'
    rows[2].error = 'Second verification read failed'
    const assessments = labels(rows)
    const report = auditQualityScore(rows, assessments, 1)
    expect(report.arms[2].usefulDistinctMechanisms?.mean).toBe(0)
    expect(report.arms[2].usefulNovelMechanisms?.mean).toBe(0)
    assessments[2].findings[0].valid = null
    expect(auditQualityScore(rows, assessments, 1).quality).toBe(
      'unknown-awaiting-independent-labels'
    )
  })
  it('rejects malformed resources and label types before arithmetic or trimming', () => {
    const rows = trials()
    for (const resources of [
      { ...rows[0].resources, wallClockMs: Number.NaN },
      { ...rows[0].resources, attempts: -1 },
      { ...rows[0].resources, tokens: Number.POSITIVE_INFINITY }
    ]) {
      expect(() =>
        auditQualityScore([{ ...rows[0], resources }, ...rows.slice(1)], [], 1)
      ).toThrow()
    }
    const assessments = labels(rows)
    for (const label of [
      { ...assessments[0], assessor: 7 },
      { ...assessments[0], evidenceRef: null },
      { ...assessments[0], independent: 'true' },
      { ...assessments[0], findings: [{ ...assessments[0].findings[0], valid: 'true' }] }
    ]) {
      expect(() => auditQualityScore(rows, [label, ...assessments.slice(1)], 1)).toThrow()
    }
    expect(() =>
      auditQualityScore([{ ...rows[0], mode: 'fixture' }, ...rows.slice(1)], [], 1)
    ).toThrow('fixture and live')
    expect(() =>
      auditQualityScore([{ ...rows[0], arm: 'unplanned' }, ...rows.slice(1)], [], 1)
    ).toThrow()
    expect(() =>
      auditQualityScore([{ ...rows[0], repetition: 2 }, ...rows.slice(1)], [], 1)
    ).toThrow()
  })
})
