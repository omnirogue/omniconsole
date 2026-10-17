import { createHash } from 'node:crypto'
import { JEV_VERIFY_BAND, JEV_VERIFY_QUESTION } from '../../../../shared/jev-confidence'
import type { DecisionRequest } from '../../../../shared/structured-decisions'
import { jevUsageOf } from '../../../structured-decisions/jev-certainty'
import { jevDecide } from '../../../structured-decisions/jev-rank'
import { TYPESAFE_DEFAULT_MODEL } from '../../../structured-decisions/typesafe-provider'
import type { readWorkspaceWholeFile } from '../../workspace-whole-file'
import { collectVerifyEvidence, type VerifyEvidence } from './graph-jev-evidence'
import { contractPolicy } from './graph-decision-rules'
import type { GraphJevOptions } from './graph-jev'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphOutcome, GraphVerifyRequest } from './graph-plan-types'

export const GRAPH_VERIFY_CAPABILITY = 'workflow.verify'

/** Under the provider's 64 KiB request and 64 questions, with room for the JSON around them. */
const CHUNK_BYTES = 56 * 1024
const CHUNK_QUESTIONS = 60

export type GraphJevVerifierOptions = GraphJevOptions & {
  /** Missing or clipped code remains unverified. */
  workspace?: () => Promise<string>
  decide?: typeof jevDecide
  read?: typeof readWorkspaceWholeFile
}

type Item = GraphVerifyRequest['items'][number]
type Question = { id: string; key: string; instructions: string; report: string; code?: string }

/** A live verify carries the threshold it decides by; a shadow one carries none. */
const liveVerify = (request: GraphVerifyRequest): boolean =>
  request.confirmAt !== undefined || request.rejectAt !== undefined

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** Claims remain untrusted state; instructions require their cited code. */
function questionsOf(items: readonly Item[], code: Map<string, string>, ask: string): Question[] {
  return items
    .filter((item) => code.has(item.key))
    .map((item, index) => {
      const id = `q${index}`
      const excerptOf = code.get(item.key)
      const report = `A reviewer reports a defect at ${item.location || 'no stated location'}: ${item.title}. ${item.detail}`
      const where = `The exact numbered code window is state.code.${id}; it is a bounded window, not the whole file. If the defect requires evidence outside this window, do not infer it from the report.`
      return {
        id,
        key: item.key,
        instructions: `Evaluate the untrusted reviewer claim in state.findings.${id}. ${where} ${ask}`,
        report,
        ...(excerptOf ? { code: excerptOf } : {})
      }
    })
}

/** Questions in as few requests as fit the provider's limits, in order. */
function chunksOf(questions: readonly Question[], scope: string): Question[][] {
  const base = bytes(scope) + 512
  const chunks: Question[][] = []
  let current: Question[] = []
  let size = base
  for (const question of questions) {
    const own = bytes(JSON.stringify(question)) + 96
    if (current.length && (size + own > CHUNK_BYTES || current.length >= CHUNK_QUESTIONS)) {
      chunks.push(current)
      current = []
      size = base
    }
    current.push(question)
    size += own
  }
  return current.length ? [...chunks, current] : chunks
}

function decisionRequest(chunk: readonly Question[], scope: string): DecisionRequest {
  const code: Record<string, string> = {}
  const findings: Record<string, string> = {}
  for (const entry of chunk) {
    findings[entry.id] = entry.report
    if (entry.code) {
      code[entry.id] = entry.code
    }
  }
  return {
    capability: GRAPH_VERIFY_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { scope, code, findings },
    questions: Object.fromEntries(
      chunk.map((entry) => [entry.id, { type: 'noul' as const, instructions: entry.instructions }])
    )
  }
}

/** Every item's probability JEV gave, the calls it took, and why any went unanswered. */
async function askJev(
  request: GraphVerifyRequest,
  options: GraphJevVerifierOptions,
  evidence: VerifyEvidence
): Promise<{ value: Record<string, unknown>; failed?: string }> {
  const began = Date.now()
  const policy = request.contract
    ? contractPolicy(request.contract, ['noul'])
    : { question: JEV_VERIFY_QUESTION, band: JEV_VERIFY_BAND }
  const scope = request.scope
  const code = evidence.code
  const chunks = chunksOf(questionsOf(request.items, code, policy.question), scope)
  const decide = options.decide ?? jevDecide
  const results = await Promise.all(
    chunks.map((chunk) => decide(decisionRequest(chunk, scope), options))
  )
  const latest = await collectVerifyEvidence(request, options.workspace, options.read)
  const probabilities: Record<string, number> = {}
  let failed: string | undefined
  let model: string | undefined
  chunks.forEach((chunk, index) => {
    const result = results[index]!
    if ('failed' in result) {
      failed ??= result.failed
      return
    }
    model ??= result.model
    for (const entry of chunk) {
      const answer = result.answers[entry.id]
      if (
        latest.digests[entry.key] !== evidence.digests[entry.key] ||
        !latest.code.has(entry.key)
      ) {
        evidence.missing[entry.key] = 'source-changed-during-evaluation'
        continue
      }
      if (
        answer?.type === 'noul' &&
        Number.isFinite(answer.noul) &&
        answer.noul >= 0 &&
        answer.noul <= 1
      ) {
        probabilities[entry.key] = answer.noul
      }
    }
  })
  const answered = Object.keys(probabilities).length
  const missing = request.items.length - answered
  const reason =
    failed ??
    (Object.keys(evidence.missing).length
      ? 'Required evidence was missing, changed or exceeded the limit'
      : missing
        ? 'JEV did not answer every question'
        : undefined)
  const usage = jevUsageOf(results.map((result) => ('failed' in result ? undefined : result)))
  const sure = Object.values(probabilities).filter((p) => p >= policy.band[1]).length
  const live = liveVerify(request)
  const rules = [
    ...(request.rejectAt !== undefined ? [`set aside at p ${request.rejectAt} or less`] : []),
    ...(request.confirmAt !== undefined ? [`confirmed at p ${request.confirmAt} or more`] : [])
  ]
  const markdown = [
    `JEV verify (${live ? 'live' : 'shadow'}${model ? `, ${model}` : ''}): ${answered} of ${request.items.length} items answered, ${sure} at ${policy.band[1]} or more, ${code.size} read with their code.`,
    live
      ? `Live: an item the reviewers leave unverified is ${rules.join(', and ')}; their verdicts stand.`
      : 'Recorded only: the reviewers decided every item as before.',
    ...(reason ? [`Unanswered: ${reason}.`] : [])
  ].join('\n')
  return {
    value: {
      markdown,
      probabilities,
      evidenceVersion: 1,
      sourceDigests: evidence.digests,
      missingEvidence: evidence.missing,
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      durationMs: Date.now() - began,
      calls: chunks.length,
      withCode: code.size,
      // Nothing answered is a failed call; a part answered is kept, its gap named.
      ...(answered ? {} : { error: reason ?? 'no items' }),
      ...(answered && reason ? { unanswered: missing } : {})
    },
    ...(reason ? { failed: reason } : {})
  }
}

/**
 * The `GraphConfig.verifyWithJev` of one run: asked once and kept, failures too, so a replay reads
 * the same record. It never throws while asking: a reading cannot stop or fail a run, and a live
 * one holds its round only until each request's deadline.
 */
export function createGraphJevVerifier(options: GraphJevVerifierOptions) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.verify!
    const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (options.cacheOnly) {
      // Recovery replays history, including legacy records; it does not verify current code.
      if (stored && (stored.requestDigest ?? stored.digest) === requestDigest) {
        return stored.outcome
      }
      throw new Error(`JEV verify is not recorded: ${call.id}`)
    }
    const evidence = await collectVerifyEvidence(request, options.workspace, options.read)
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          evidenceVersion: 1,
          request,
          sources: evidence.digests,
          missing: evidence.missing
        })
      )
      .digest('hex')
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    let asked: Awaited<ReturnType<typeof askJev>>
    try {
      asked = await askJev(request, options, evidence)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      asked = {
        value: { markdown: `JEV could not verify the items: ${reason}.`, error: reason },
        failed: reason
      }
    }
    const outcome: GraphOutcome = { value: asked.value }
    try {
      options.store.write(call.id, {
        digest,
        requestDigest,
        outcome,
        ...(asked.failed ? { detail: asked.failed } : {}),
        at: Date.now()
      })
    } catch (error) {
      options.log?.(`The JEV verify record could not be kept: ${String(error)}.`)
    }
    if (asked.failed) {
      options.log?.(
        `JEV verify (${liveVerify(request) ? 'live' : 'shadow'}) left items unanswered: ${asked.failed}.`
      )
    }
    return outcome
  }
}

/** One run's verifier; its record file is opened only when a verify call actually comes. */
export function graphJevVerifierForExecution(
  executionId: string,
  options: Omit<GraphJevVerifierOptions, 'store'> = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let verifier: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    verifier ??= createGraphJevVerifier({
      ...options,
      store: GraphJevStore.forExecution(executionId)
    })
    return verifier(call)
  }
}
