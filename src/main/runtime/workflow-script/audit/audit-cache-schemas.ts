import type { JsonSchema } from '../../../../shared/json-schema-validate'
import { JEV_MODEL } from '../../../../shared/jev-confidence'
import type { AuditEvidenceStatus } from './audit-evidence'
import { AUDIT_JUDGEMENT_VERSION, AUDIT_THRESHOLD_VERSION } from './audit-judgement-contract'

const EVIDENCE_STATUSES: AuditEvidenceStatus[] = [
  'verified',
  'source-not-registered',
  'source-missing',
  'source-unreadable',
  'source-id-mismatch',
  'source-changed',
  'quote-not-found',
  'invalid-quote'
]
const sourceId: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 }
const quote: JsonSchema = { type: 'string', maxLength: 300 }
const count: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }

export function auditEvidencePacketSchema(citationCount: number): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['check', 'excerpts'],
    properties: {
      check: {
        type: 'object',
        additionalProperties: false,
        required: ['citations', 'citedSourceCount', 'verifiedSourceCount', 'allVerified'],
        properties: {
          citations: {
            type: 'array',
            minItems: citationCount,
            maxItems: citationCount,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sourceId', 'quote', 'status'],
              properties: { sourceId, quote, status: { type: 'string', enum: EVIDENCE_STATUSES } }
            }
          },
          citedSourceCount: count,
          verifiedSourceCount: count,
          allVerified: { type: 'boolean' }
        }
      },
      excerpts: {
        type: 'array',
        maxItems: citationCount,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceId', 'quote', 'surrounding'],
          properties: { sourceId, quote, surrounding: { type: 'string', maxLength: 1_900 } }
        }
      }
    }
  }
}

const probability: JsonSchema = { type: 'number', minimum: 0, maximum: 1 }
const levels = ['0', '1', '2', '3', '4']
const prediction: JsonSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'noul'],
      properties: { type: { const: 'noul' }, noul: probability }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'score', 'probabilities'],
      properties: {
        type: { const: 'score' },
        score: { type: 'number', minimum: 0, maximum: 4 },
        probabilities: {
          type: 'object',
          additionalProperties: false,
          required: levels,
          properties: Object.fromEntries(levels.map((level) => [level, probability]))
        }
      }
    }
  ]
}

export function auditJudgementObservationSchema(callId: string): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'callId',
      'model',
      'questionVersion',
      'thresholdVersion',
      'route',
      'status',
      'reason',
      'stateHash',
      'durationMs',
      'missingQuestionIds',
      'usage',
      'predictions'
    ],
    properties: {
      callId: { type: 'string', const: callId },
      model: { const: JEV_MODEL },
      questionVersion: { const: AUDIT_JUDGEMENT_VERSION },
      thresholdVersion: { const: AUDIT_THRESHOLD_VERSION },
      route: { const: 'generative' },
      status: { enum: ['unknown', 'voided'] },
      reason: {
        enum: [
          'uncalibrated',
          'missing-redaction',
          'unverified-evidence',
          'invalid-input',
          'unavailable',
          'invalid-response'
        ]
      },
      stateHash: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
      durationMs: count,
      missingQuestionIds: {
        type: 'array',
        maxItems: 64,
        items: { type: 'string', maxLength: 96 }
      },
      usage: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['inputTokens', 'outputTokens'],
            properties: { inputTokens: count, outputTokens: count }
          }
        ]
      },
      predictions: { type: 'object', additionalProperties: prediction }
    }
  }
}
