import { describe, expect, it } from 'vitest'
import { JEV_MODEL } from '../../../../shared/jev-confidence'
import type { AuditCitation } from '../../../../shared/workflow-audit-contracts'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import {
  assertAuditEvidencePacket,
  assertAuditJudgementObservation
} from './audit-cache-validation'
import { buildAuditCorpus } from './audit-corpus'
import { verifyAuditEvidence } from './audit-evidence'
import {
  observeAuditJudgements,
  type AuditJudgementObservation,
  type AuditJudgementRequest
} from './audit-judgements'
import type { AuditEvidencePacket } from './audit-source-store'

const source = { id: 'S1', timestamp: '2026-10-02T12:00:00Z', text: 'Setup failed. Try again.' }
const manifest = buildAuditCorpus([source], { maxChunkBytes: 4_096 }).sources
const citations = [
  { sourceId: 'S1', quote: 'Setup failed.' },
  { sourceId: 'S1', quote: 'Try again.' }
]

async function evidence(input: AuditCitation[] = citations): Promise<AuditEvidencePacket> {
  const check = await verifyAuditEvidence(input, manifest, async () => source)
  return {
    check,
    excerpts: check.citations
      .filter((citation) => citation.status === 'verified')
      .map(({ sourceId, quote }) => ({ sourceId, quote, surrounding: source.text }))
  }
}

describe('audit evidence cache validation', () => {
  it('accepts real checks, repeated occurrences, absent and unreadable sources', async () => {
    const repeated = [...citations, citations[0]]
    expect(
      assertAuditEvidencePacket(await evidence(repeated), repeated, manifest).check
        .verifiedSourceCount
    ).toBe(1)
    for (const loader of [
      async () => null,
      async () => {
        throw new Error('Offline')
      }
    ]) {
      const packet = { check: await verifyAuditEvidence(citations, manifest, loader), excerpts: [] }
      expect(assertAuditEvidencePacket(packet, citations, manifest)).toEqual(packet)
    }
    expect(assertAuditEvidencePacket(await evidence([]), [], manifest).check.allVerified).toBe(
      false
    )
  })

  it('preserves source-not-registered and invalid-quote without admitting them as verified', async () => {
    const input = [
      { sourceId: '../unregistered', quote: 'Some text' },
      { sourceId: 'missing', quote: ' ' }
    ]
    const packet = await evidence(input)
    expect(
      assertAuditEvidencePacket(packet, input, manifest).check.citations.map(({ status }) => status)
    ).toEqual(['source-not-registered', 'invalid-quote'])
    packet.check.citations[0].status = 'source-unreadable'
    expect(() => assertAuditEvidencePacket(packet, input, manifest)).toThrow('status contradicts')
  })

  it.each([
    [
      'missing citation',
      (packet: AuditEvidencePacket) => {
        packet.check.citations.pop()
      }
    ],
    [
      'reordered citations',
      (packet: AuditEvidencePacket) => {
        packet.check.citations.reverse()
      }
    ],
    [
      'changed quote',
      (packet: AuditEvidencePacket) => {
        packet.check.citations[0].quote = 'Forged'
      }
    ],
    [
      'changed source',
      (packet: AuditEvidencePacket) => {
        packet.check.citations[0].sourceId = 'S2'
      }
    ],
    [
      'inflated source count',
      (packet: AuditEvidencePacket) => {
        packet.check.citedSourceCount = 2
      }
    ],
    [
      'counted quotes as sources',
      (packet: AuditEvidencePacket) => {
        packet.check.verifiedSourceCount = 2
      }
    ],
    [
      'inverted allVerified',
      (packet: AuditEvidencePacket) => {
        packet.check.allVerified = false
      }
    ],
    [
      'missing excerpt',
      (packet: AuditEvidencePacket) => {
        packet.excerpts.pop()
      }
    ],
    [
      'reordered excerpts',
      (packet: AuditEvidencePacket) => {
        packet.excerpts.reverse()
      }
    ],
    [
      'wrong surrounding text',
      (packet: AuditEvidencePacket) => {
        packet.excerpts[0].surrounding = 'Unrelated'
      }
    ],
    [
      'oversized surrounding prefix',
      (packet: AuditEvidencePacket) => {
        packet.excerpts[0].surrounding = `${'x'.repeat(801)}Setup failed.`
      }
    ],
    [
      'oversized surrounding suffix',
      (packet: AuditEvidencePacket) => {
        packet.excerpts[0].surrounding = `Setup failed.${'x'.repeat(801)}`
      }
    ],
    [
      'nonfinite count',
      (packet: AuditEvidencePacket) => {
        packet.check.verifiedSourceCount = Number.NaN
      }
    ],
    [
      'inconsistent read failure',
      (packet: AuditEvidencePacket) => {
        packet.check.citations[0].status = 'source-unreadable'
      }
    ]
  ])('rejects %s', async (_name, corrupt) => {
    const packet = await evidence()
    corrupt(packet)
    expect(() => assertAuditEvidencePacket(packet, citations, manifest)).toThrow()
  })

  it('rejects unknown fields, status values, and duplicate registry IDs', async () => {
    const packet = await evidence()
    expect(() =>
      assertAuditEvidencePacket({ ...packet, trust: true }, citations, manifest)
    ).toThrow('not allowed')
    expect(() =>
      assertAuditEvidencePacket(
        {
          ...packet,
          check: {
            ...packet.check,
            citations: [
              { ...packet.check.citations[0], status: 'probably-verified' },
              packet.check.citations[1]
            ]
          }
        },
        citations,
        manifest
      )
    ).toThrow('expected one of')
    expect(() => assertAuditEvidencePacket(packet, citations, [...manifest, manifest[0]])).toThrow(
      'duplicate source'
    )
  })
})

const request: AuditJudgementRequest = {
  callId: 'audit/shadow/1',
  findings: ['A', 'B'].map((id) => ({
    id,
    title: 'Setup',
    description: 'Repeated setup delays work.',
    proposedFix: 'Reuse a recipe.',
    impact: 3,
    evidence: [citations[0]]
  })),
  pairs: [{ kind: 'agreement', aId: 'A', bId: 'B' }],
  verifiedSourceIds: ['S1']
}

async function answer(input: DecisionRequest): Promise<DecisionResult> {
  return {
    provider: 'typesafe',
    model: JEV_MODEL,
    usage: { inputTokens: 10, outputTokens: 5 },
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([id, question]) => [
        id,
        question.type === 'score'
          ? {
              type: 'score',
              score: 4,
              confidence: 1,
              legend: Object.fromEntries(
                question.criteria.map((value, index) => [String(index), value])
              ),
              probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 }
            }
          : { type: 'noul', noul: 0.75 }
      ])
    )
  }
}

async function observation(): Promise<AuditJudgementObservation> {
  return observeAuditJudgements(request, {
    record: () => {},
    redact: (text) => text,
    environment: {},
    credential: async () => 'test-key',
    evaluate: answer
  })
}

describe('audit judgement cache validation', () => {
  it('accepts genuine shadow predictions and each no-prediction fallback', async () => {
    const result = await observation()
    expect(assertAuditJudgementObservation(result, request)).toEqual(result)
    for (const reason of [
      'missing-redaction',
      'unverified-evidence',
      'invalid-input',
      'unavailable',
      'invalid-response'
    ] as const) {
      const failure: AuditJudgementObservation = {
        ...result,
        reason,
        status: reason === 'invalid-response' ? 'voided' : 'unknown',
        predictions: {},
        usage: null,
        stateHash: ['unavailable', 'invalid-response'].includes(reason) ? result.stateHash : null
      }
      expect(assertAuditJudgementObservation(failure, request)).toEqual(failure)
    }
  })

  it.each([
    [
      'wrong call',
      (value: AuditJudgementObservation) => {
        value.callId = 'another'
      }
    ],
    [
      'wrong model',
      (value: AuditJudgementObservation) => {
        value.model = 'jev-latest'
      }
    ],
    [
      'changed question version',
      (value: AuditJudgementObservation) => {
        value.questionVersion = 'audit-shadow@2'
      }
    ],
    [
      'changed threshold version',
      (value: AuditJudgementObservation) => {
        value.thresholdVersion = 'live@1'
      }
    ],
    [
      'no state hash',
      (value: AuditJudgementObservation) => {
        value.stateHash = null
      }
    ],
    [
      'bad state hash',
      (value: AuditJudgementObservation) => {
        value.stateHash = 'partial'
      }
    ],
    [
      'negative duration',
      (value: AuditJudgementObservation) => {
        value.durationMs = -1
      }
    ],
    [
      'nonfinite duration',
      (value: AuditJudgementObservation) => {
        value.durationMs = Number.NaN
      }
    ],
    [
      'missing prediction',
      (value: AuditJudgementObservation) => {
        delete value.predictions.rank_0
      }
    ],
    [
      'extra prediction',
      (value: AuditJudgementObservation) => {
        value.predictions.extra = { type: 'noul', noul: 1 }
      }
    ],
    [
      'wrong prediction type',
      (value: AuditJudgementObservation) => {
        value.predictions.rank_0 = { type: 'noul', noul: 1 }
      }
    ],
    [
      'out of range noul',
      (value: AuditJudgementObservation) => {
        value.predictions.pair_0 = { type: 'noul', noul: 2 }
      }
    ],
    [
      'nonfinite noul',
      (value: AuditJudgementObservation) => {
        value.predictions.pair_0 = { type: 'noul', noul: Number.NaN }
      }
    ],
    [
      'no usage',
      (value: AuditJudgementObservation) => {
        value.usage = null
      }
    ],
    [
      'missing question with successful predictions',
      (value: AuditJudgementObservation) => {
        value.missingQuestionIds = ['rank_0']
      }
    ],
    [
      'unknown missing question',
      (value: AuditJudgementObservation) => {
        value.missingQuestionIds = ['other']
      }
    ],
    [
      'inconsistent status',
      (value: AuditJudgementObservation) => {
        value.status = 'voided'
      }
    ],
    [
      'failed but contains predictions',
      (value: AuditJudgementObservation) => {
        value.reason = 'unavailable'
      }
    ]
  ])('rejects %s', async (_name, corrupt) => {
    const value = await observation()
    corrupt(value)
    expect(() => assertAuditJudgementObservation(value, request)).toThrow()
  })

  it('uses the provider probability and expected-score validation on cache replay', async () => {
    for (const patch of [
      { score: Number.NaN },
      { score: 3 },
      { probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 } },
      { probabilities: { '0': 0, '1': 0, '2': 0, '3': Number.NaN, '4': 1 } },
      { probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 } }
    ]) {
      const value = await observation()
      value.predictions.rank_0 = {
        ...value.predictions.rank_0,
        ...patch
      } as typeof value.predictions.rank_0
      expect(() => assertAuditJudgementObservation(value, request)).toThrow()
    }
  })

  it('rejects decision-bearing fields, live routes, and predictions against unverified inputs', async () => {
    const value = await observation()
    expect(() => assertAuditJudgementObservation({ ...value, route: 'jev' }, request)).toThrow()
    expect(() => assertAuditJudgementObservation({ ...value, winner: 'A' }, request)).toThrow()
    expect(() =>
      assertAuditJudgementObservation(
        {
          ...value,
          predictions: { ...value.predictions, pair_0: { type: 'noul', noul: 1, accepted: true } }
        },
        request
      )
    ).toThrow()
    expect(() =>
      assertAuditJudgementObservation(value, { ...request, verifiedSourceIds: [] })
    ).toThrow('lacks verified input')
    expect(() =>
      assertAuditJudgementObservation(value, {
        ...request,
        pairs: [{ kind: 'duplicate', aId: 'A', bId: 'unknown' }]
      })
    ).toThrow('lacks verified input')
  })
})
