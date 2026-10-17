import { describe, expect, it } from 'vitest'
import { unusableAgentSchemaReason, validateJsonSchema } from './json-schema-validate'
import {
  AUDIT_AGREEMENT_SCHEMA,
  AUDIT_CLUSTER_SCHEMA,
  AUDIT_NOVELTY_SCHEMA,
  AUDIT_READER_SCHEMA,
  AUDIT_VERIFY_SCHEMA,
  type AuditFinding
} from './workflow-audit-contracts'
import {
  assertAuditCluster,
  assertAuditNovelty,
  assertAuditReader,
  assertAuditVerification,
  distinctAuditSourceIds,
  summarizeAuditAgreement
} from './workflow-audit-validation'

const finding = (id = 'F1'): AuditFinding => ({
  id,
  title: 'Repeated setup',
  description: 'Each task repeats the same setup.',
  impact: 3,
  proposedFix: 'Reuse the workspace recipe.',
  evidence: [{ sourceId: 'S1', quote: 'Had to set this up again.' }]
})

describe('versioned audit contracts', () => {
  it('uses schemas accepted by the existing agent boundary', () => {
    for (const schema of [
      AUDIT_READER_SCHEMA,
      AUDIT_CLUSTER_SCHEMA,
      AUDIT_VERIFY_SCHEMA,
      AUDIT_NOVELTY_SCHEMA,
      AUDIT_AGREEMENT_SCHEMA
    ]) {
      expect(unusableAgentSchemaReason(schema)).toBeNull()
      expect(validateJsonSchema(schema, { version: 2 })).not.toEqual([])
    }
  })

  it('permits empty readings but requires exactly the supplied source set', () => {
    const value = { version: 1, chunkId: 'C1', sourceIds: ['S1', 'S2'], findings: [] }
    expect(assertAuditReader(value, 'C1', ['S2', 'S1'])).toEqual(value)
    expect(() => assertAuditReader(value, 'C2', ['S1', 'S2'])).toThrow('chunk')
    expect(() => assertAuditReader(value, 'C1', ['S1'])).toThrow('every supplied')
    expect(() =>
      assertAuditReader({ ...value, sourceIds: ['S1', 'S1'] }, 'C1', ['S1', 'S2'])
    ).toThrow('unique')
  })

  it.each([
    { ...finding(), evidence: [] },
    { ...finding(), impact: 6 },
    { ...finding(), impact: 2.5 },
    { ...finding(), title: '   ' },
    { ...finding(), evidenceCount: 100 },
    { ...finding(), evidence: [{ sourceId: 'S1', quote: 'x'.repeat(301) }] },
    { ...finding(), title: 'x'.repeat(201) },
    { ...finding(), description: 'x'.repeat(4_001) },
    { ...finding(), proposedFix: 'x'.repeat(2_001) },
    {
      ...finding(),
      evidence: Array.from({ length: 129 }, (_, index) => ({
        sourceId: 'S1',
        quote: String(index)
      }))
    }
  ])('rejects malformed findings and model-authored evidence counts', (invalid) => {
    expect(() => assertAuditCluster({ version: 1, findings: [invalid] }, [finding()])).toThrow()
  })

  it('rejects duplicate finding ids and citations from other chunks', () => {
    const reader = {
      version: 1,
      chunkId: 'C1',
      sourceIds: ['S1'],
      findings: [finding(), finding()]
    }
    expect(() => assertAuditReader(reader, 'C1', ['S1'])).toThrow('unique')
    reader.findings = [{ ...finding(), evidence: [{ sourceId: 'S2', quote: 'Outside chunk' }] }]
    expect(() => assertAuditReader(reader, 'C1', ['S1'])).toThrow('unsupplied source')
  })

  it('allows merged claims only with exact upstream evidence and counts distinct sources in code', () => {
    const original = finding()
    const other = { ...finding('F2'), evidence: [{ sourceId: 'S1', quote: 'Another quote.' }] }
    const merged = { ...finding('T1'), evidence: [...original.evidence, ...other.evidence] }
    expect(
      assertAuditCluster({ version: 1, findings: [merged] }, [original, other]).findings
    ).toEqual([merged])
    expect(distinctAuditSourceIds(merged)).toEqual(['S1'])
    expect(() => assertAuditCluster({ version: 1, findings: [merged] }, [original])).toThrow(
      'introduced evidence'
    )
    expect(() =>
      assertAuditCluster(
        {
          version: 1,
          findings: [{ ...merged, evidence: [...merged.evidence, original.evidence[0]] }]
        },
        [original, other]
      )
    ).toThrow('unique')
  })

  it('refuses a merge that silently drops findings or their supporting citations', () => {
    const first = finding()
    const second = {
      ...finding('F2'),
      evidence: [{ sourceId: 'S2', quote: 'A second observation.' }]
    }
    expect(() => assertAuditCluster({ version: 1, findings: [] }, [first])).toThrow(
      'omitted evidence'
    )
    expect(() => assertAuditCluster({ version: 1, findings: [first] }, [first, second])).toThrow(
      'omitted evidence'
    )
    expect(assertAuditCluster({ version: 1, findings: [] }, []).findings).toEqual([])
    expect(
      assertAuditCluster({ version: 1, findings: [first, second] }, [first, second]).findings
    ).toEqual([first, second])
  })

  it('keeps overlapping same-source quotes distinct and offers bounded v4 omission detail', () => {
    const fullQuote = 'The user repeated the same setup steps.'
    const shortQuote = 'the same setup'
    const full = { ...finding(), evidence: [{ sourceId: 'S1', quote: fullQuote }] }
    const short = { ...finding('F2'), evidence: [{ sourceId: 'S1', quote: shortQuote }] }
    const omittedShort = { version: 1, findings: [{ ...full, id: 'T1' }] }
    const preservedBoth = {
      version: 1,
      findings: [{ ...full, id: 'T1', evidence: [full.evidence[0], short.evidence[0]] }]
    }

    expect(() => assertAuditCluster(omittedShort, [full, short])).toThrow(
      'Cluster omitted evidence from its inputs'
    )
    expect(() =>
      assertAuditCluster(omittedShort, [full, short], { includeOmissionDetails: true })
    ).toThrow(JSON.stringify(['S1', shortQuote]))
    expect(
      assertAuditCluster(preservedBoth, [full, short], { includeOmissionDetails: true }).findings
    ).toEqual(preservedBoth.findings)

    const manyPairs = {
      ...finding(),
      evidence: Array.from({ length: 10 }, (_, index) => ({
        sourceId: 'S1',
        quote: `${'q'.repeat(290)}${String(index).padStart(2, '0')}`
      }))
    }
    let diagnostic = ''
    try {
      assertAuditCluster({ version: 1, findings: [] }, [manyPairs], {
        includeOmissionDetails: true
      })
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error)
    }
    expect(diagnostic.length).toBeLessThanOrEqual(1500)
    expect(diagnostic).toContain('missingCount=10')
    expect(diagnostic).toContain('diagnosticOmittedCount=')
    expect(diagnostic).toContain('untrusted data')
    const encodedPairs = diagnostic.slice(
      diagnostic.indexOf('untrusted data: ') + 'untrusted data: '.length
    )
    expect(JSON.parse(encodedPairs)).toEqual(
      manyPairs.evidence
        .slice(0, JSON.parse(encodedPairs).length)
        .map(({ sourceId, quote }) => [sourceId, quote])
    )
    expect(JSON.parse(encodedPairs).length).toBeLessThan(manyPairs.evidence.length)
  })

  it('bounds reader and cluster output sizes before admitting a result', () => {
    const findings = Array.from({ length: 129 }, (_, index) => finding(`F${index}`))
    expect(() =>
      assertAuditReader(
        { version: 1, chunkId: 'C1', sourceIds: ['S1'], findings: findings.slice(0, 25) },
        'C1',
        ['S1']
      )
    ).toThrow('at most 24 items')
    expect(() => assertAuditCluster({ version: 1, findings }, findings)).toThrow(
      'at most 128 items'
    )
  })

  it('requires novelty context, fresh ids and an existing target for contradictions', () => {
    const novel = {
      version: 1,
      lens: 'Counterexamples',
      existingFindingIds: ['F1'],
      findings: [
        {
          ...finding('N1'),
          whyNotCovered: 'The original fix already exists.',
          contradictsFindingId: 'F1'
        }
      ]
    }
    expect(assertAuditNovelty(novel, [finding()], ['S1'])).toEqual(novel)
    expect(() =>
      assertAuditNovelty({ ...novel, existingFindingIds: [] }, [finding()], ['S1'])
    ).toThrow('every supplied')
    expect(() =>
      assertAuditNovelty(
        { ...novel, findings: [{ ...novel.findings[0], id: 'F1' }] },
        [finding()],
        ['S1']
      )
    ).toThrow('reused')
    expect(() =>
      assertAuditNovelty(
        { ...novel, findings: [{ ...novel.findings[0], contradictsFindingId: 'F2' }] },
        [finding()],
        ['S1']
      )
    ).toThrow('unknown id')
    expect(() =>
      assertAuditNovelty({ ...novel, findings: [finding('N1')] }, [finding()], ['S1'])
    ).toThrow('whyNotCovered')
  })

  it('retains unknown verification rather than converting it into a refutation', () => {
    expect(
      assertAuditVerification({
        version: 1,
        verdict: 'unknown',
        reason: 'Source unavailable.',
        status: 'unknown'
      }).verdict
    ).toBe('unknown')
    expect(() =>
      assertAuditVerification({ version: 1, verdict: 'confirmed', reason: '' })
    ).toThrow()
  })

  it('computes agreement from distinct matched ids, including asymmetric grouping', () => {
    const matches = [
      { aId: 'A1', bId: 'B1', reason: 'Same setup problem.' },
      { aId: 'A2', bId: 'B1', reason: 'The second reader grouped two examples.' }
    ]
    expect(
      summarizeAuditAgreement(
        { version: 1, matches },
        [finding('A1'), finding('A2')],
        [finding('B1'), finding('B2')]
      )
    ).toEqual({
      aTotal: 2,
      bTotal: 2,
      aMatched: 2,
      bMatched: 1,
      agreementRate: 0.75,
      onlyA: [],
      onlyB: ['B2']
    })
    expect(summarizeAuditAgreement({ version: 1, matches: [] }, [], []).agreementRate).toBeNull()
    expect(() =>
      summarizeAuditAgreement(
        { version: 1, matches: [matches[0], matches[0]] },
        [finding('A1')],
        [finding('B1')]
      )
    ).toThrow('unique')
    expect(() =>
      summarizeAuditAgreement({ version: 1, matches }, [finding('A1')], [finding('B1')])
    ).toThrow('unsupplied finding')
  })
})
