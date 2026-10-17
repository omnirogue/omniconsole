import {
  describeJsonSchemaProblems,
  validateJsonSchema,
  type JsonSchema
} from '../../../../shared/json-schema-validate'
import { JEV_MODEL } from '../../../../shared/jev-confidence'
import {
  validateDecisionResult,
  type DecisionAnswer,
  type DecisionQuestion
} from '../../../../shared/structured-decisions'
import type { AuditCitation } from '../../../../shared/workflow-audit-contracts'
import { assertAuditCluster } from '../../../../shared/workflow-audit-validation'
import type { AuditSourceManifest } from './audit-corpus'
import {
  auditAvailabilityQuestion,
  auditPairQuestion,
  auditRankQuestion
} from './audit-judgement-contract'
import type { AuditJudgementObservation, AuditJudgementRequest } from './audit-judgements'
import type { AuditEvidencePacket } from './audit-source-store'
import { auditEvidencePacketSchema, auditJudgementObservationSchema } from './audit-cache-schemas'

function assertShape<T>(value: unknown, schema: JsonSchema, label: string): T {
  const problems = validateJsonSchema(schema, value)
  if (problems.length) {
    throw new Error(`${label}: ${describeJsonSchemaProblems(problems)}`)
  }
  return value as T
}

/** Cached evidence has the same citation occurrences and derived facts as the original request. */
export function assertAuditEvidencePacket(
  value: unknown,
  citations: readonly AuditCitation[],
  manifest: readonly AuditSourceManifest[]
): AuditEvidencePacket {
  const packet = assertShape<AuditEvidencePacket>(
    value,
    auditEvidencePacketSchema(citations.length),
    'Invalid audit evidence cache'
  )
  const registered = new Set(manifest.map((source) => source.id))
  if (registered.size !== manifest.length) {
    throw new Error('Invalid audit evidence cache: duplicate source manifest IDs')
  }
  const loaded = new Map<string, string>()
  packet.check.citations.forEach((citation, index) => {
    const expected = citations[index]
    if (citation.sourceId !== expected.sourceId || citation.quote !== expected.quote) {
      throw new Error('Invalid audit evidence cache: citation occurrence changed')
    }
    const invalidQuote = !citation.quote.trim()
    const unregistered = !registered.has(citation.sourceId)
    if (
      invalidQuote
        ? citation.status !== 'invalid-quote'
        : unregistered
          ? citation.status !== 'source-not-registered'
          : ['invalid-quote', 'source-not-registered'].includes(citation.status)
    ) {
      throw new Error('Invalid audit evidence cache: citation status contradicts its inputs')
    }
    if (!invalidQuote && !unregistered) {
      const status = ['verified', 'quote-not-found'].includes(citation.status)
        ? 'readable'
        : citation.status
      if (loaded.has(citation.sourceId) && loaded.get(citation.sourceId) !== status) {
        throw new Error('Invalid audit evidence cache: inconsistent source read status')
      }
      loaded.set(citation.sourceId, status)
    }
  })
  const verified = packet.check.citations.filter((citation) => citation.status === 'verified')
  if (
    packet.check.citedSourceCount !==
      new Set(citations.map((citation) => citation.sourceId)).size ||
    packet.check.verifiedSourceCount !==
      new Set(verified.map((citation) => citation.sourceId)).size ||
    packet.check.allVerified !== (citations.length > 0 && verified.length === citations.length)
  ) {
    throw new Error('Invalid audit evidence cache: derived counts or allVerified changed')
  }
  if (packet.excerpts.length !== verified.length) {
    throw new Error('Invalid audit evidence cache: missing or extra verified excerpts')
  }
  packet.excerpts.forEach((excerpt, index) => {
    const citation = verified[index]
    const at = excerpt.surrounding.indexOf(excerpt.quote)
    if (
      excerpt.sourceId !== citation.sourceId ||
      excerpt.quote !== citation.quote ||
      at === -1 ||
      at > 800 ||
      excerpt.surrounding.length - at - excerpt.quote.length > 800
    ) {
      throw new Error('Invalid audit evidence cache: excerpt does not match its verified citation')
    }
  })
  return packet
}

function expectedQuestions(request: AuditJudgementRequest): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {}
  if (request.rankThemes !== false) {
    request.findings.forEach((_, index) => {
      questions[`rank_${index}`] = auditRankQuestion(`F${index + 1}`)
      questions[`rank_${index}_availability`] = auditAvailabilityQuestion('the finding has impact')
    })
  }
  request.pairs.forEach((pair, index) => {
    questions[`pair_${index}`] = auditPairQuestion(pair.kind, 'left', 'right')
    questions[`pair_${index}_availability`] = auditAvailabilityQuestion(
      'the findings describe the same issue'
    )
  })
  return questions
}

/** Only complete, bounded predictions may replay; a cache can never change the generative route. */
export function assertAuditJudgementObservation(
  value: unknown,
  request: AuditJudgementRequest
): AuditJudgementObservation {
  const observation = assertShape<AuditJudgementObservation>(
    value,
    auditJudgementObservationSchema(request.callId),
    'Invalid audit judgement cache'
  )
  const questions = expectedQuestions(request)
  const keys = Object.keys(questions)
  if (
    new Set(observation.missingQuestionIds).size !== observation.missingQuestionIds.length ||
    observation.missingQuestionIds.some((id) => !Object.hasOwn(questions, id))
  ) {
    throw new Error('Invalid audit judgement cache: missing question IDs do not match request')
  }
  if ((observation.status === 'voided') !== (observation.reason === 'invalid-response')) {
    throw new Error('Invalid audit judgement cache: inconsistent status and reason')
  }
  const inferenceAttempted = ['uncalibrated', 'unavailable', 'invalid-response'].includes(
    observation.reason
  )
  if (inferenceAttempted !== (observation.stateHash !== null)) {
    throw new Error('Invalid audit judgement cache: inconsistent state hash')
  }
  if (observation.reason !== 'uncalibrated') {
    if (
      Object.keys(observation.predictions).length ||
      observation.usage !== null ||
      (observation.reason !== 'invalid-response' && observation.missingQuestionIds.length)
    ) {
      throw new Error('Invalid audit judgement cache: failed inference contains predictions')
    }
    return observation
  }
  if (
    keys.length === 0 ||
    keys.length > 64 ||
    observation.missingQuestionIds.length ||
    !observation.usage
  ) {
    throw new Error('Invalid audit judgement cache: incomplete prediction batch')
  }
  assertAuditCluster({ version: 1, findings: request.findings }, request.findings)
  const ids = new Set(request.findings.map((finding) => finding.id))
  const verified = new Set(request.verifiedSourceIds)
  if (
    request.findings.some((finding) =>
      finding.evidence.some((citation) => !verified.has(citation.sourceId))
    ) ||
    request.pairs.some((pair) => pair.aId === pair.bId || !ids.has(pair.aId) || !ids.has(pair.bId))
  ) {
    throw new Error('Invalid audit judgement cache: prediction lacks verified input')
  }
  const answers: Record<string, DecisionAnswer> = {}
  for (const [id, value] of Object.entries(observation.predictions)) {
    const question = questions[id]
    if (!question || question.type !== value.type) {
      throw new Error('Invalid audit judgement cache: unexpected prediction')
    }
    if (value.type === 'score' && question.type === 'score') {
      answers[id] = {
        ...value,
        confidence: 0,
        legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level]))
      }
    } else if (value.type === 'noul') {
      answers[id] = value
    }
  }
  validateDecisionResult(
    { provider: 'typesafe', model: observation.model, answers, usage: observation.usage },
    {
      capability: 'workflow.audit.shadow',
      model: JEV_MODEL,
      state: {},
      questions
    }
  )
  return observation
}
