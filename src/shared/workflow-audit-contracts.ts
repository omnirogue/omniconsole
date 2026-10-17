import type { JsonSchema } from './json-schema-validate'

export type AuditCitation = { sourceId: string; quote: string }
export type AuditFinding = {
  id: string
  title: string
  description: string
  evidence: AuditCitation[]
  impact: number
  proposedFix: string
}
export type AuditReader = {
  version: 1
  chunkId: string
  sourceIds: string[]
  findings: AuditFinding[]
}
export type AuditCluster = { version: 1; findings: AuditFinding[] }
export type AuditVerification = {
  version: 1
  verdict: 'confirmed' | 'weakened' | 'refuted' | 'unknown'
  reason: string
  adjustedImpact?: number
  status?: 'unaddressed' | 'planned' | 'in-progress' | 'shipped-not-adopted' | 'shipped' | 'unknown'
}
export type AuditNovelFinding = AuditFinding & {
  whyNotCovered: string
  contradictsFindingId?: string
}
export type AuditNovelty = {
  version: 1
  lens: string
  existingFindingIds: string[]
  findings: AuditNovelFinding[]
}
export type AuditAgreement = {
  version: 1
  matches: { aId: string; bId: string; reason: string }[]
}

export const AUDIT_MAX_CITATIONS_PER_FINDING = 128
export const AUDIT_MAX_FINDINGS_PER_CLUSTER = 128

const text: JsonSchema = { type: 'string', minLength: 1, maxLength: 4_000, pattern: '\\S' }
const id: JsonSchema = { ...text, maxLength: 200 }
const sourceIds: JsonSchema = { type: 'array', maxItems: 4_096, items: id }
const impact: JsonSchema = { type: 'integer', minimum: 1, maximum: 5 }
const version: JsonSchema = { type: 'integer', const: 1 }
const citation: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceId', 'quote'],
  properties: { sourceId: id, quote: { ...text, maxLength: 300 } }
}
const finding: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'description', 'evidence', 'impact', 'proposedFix'],
  properties: {
    id,
    title: { ...text, maxLength: 200 },
    description: text,
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: AUDIT_MAX_CITATIONS_PER_FINDING,
      items: citation
    },
    impact,
    proposedFix: { ...text, maxLength: 2_000 }
  }
}

export const AUDIT_READER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'chunkId', 'sourceIds', 'findings'],
  properties: {
    version,
    chunkId: id,
    sourceIds: { ...sourceIds, minItems: 1 },
    findings: { type: 'array', maxItems: 24, items: finding }
  }
}
export const AUDIT_CLUSTER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'findings'],
  properties: {
    version,
    findings: { type: 'array', maxItems: AUDIT_MAX_FINDINGS_PER_CLUSTER, items: finding }
  }
}
export const AUDIT_VERIFY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'verdict', 'reason'],
  properties: {
    version,
    verdict: { type: 'string', enum: ['confirmed', 'weakened', 'refuted', 'unknown'] },
    reason: text,
    adjustedImpact: impact,
    status: {
      type: 'string',
      enum: ['unaddressed', 'planned', 'in-progress', 'shipped-not-adopted', 'shipped', 'unknown']
    }
  }
}
export const AUDIT_NOVELTY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'lens', 'existingFindingIds', 'findings'],
  properties: {
    version,
    lens: { ...text, maxLength: 200 },
    existingFindingIds: sourceIds,
    findings: {
      type: 'array',
      maxItems: 24,
      items: {
        ...finding,
        required: [...finding.required!, 'whyNotCovered'],
        properties: {
          ...finding.properties,
          whyNotCovered: text,
          contradictsFindingId: id
        }
      }
    }
  }
}
export const AUDIT_AGREEMENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'matches'],
  properties: {
    version,
    matches: {
      type: 'array',
      maxItems: 576,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aId', 'bId', 'reason'],
        properties: { aId: id, bId: id, reason: text }
      }
    }
  }
}
