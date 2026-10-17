import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { rubricLibrary } from '../../shared/rubric-library'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { DecisionRecords } from './decision-records'
import { evaluateJevRubric, recordJevRubricEvaluation } from './jev-rubric-evaluation'

const entry = rubricLibrary([
  {
    name: 'Two checks',
    kind: 'code',
    instructions: '- It solves the requested task\n- It cites actual checks'
  }
]).at(-1)!
const input = { rubric: entry.value, task: 'Fix the described bug', response: 'Here is the fix.' }
function result(request: DecisionRequest, availability = 4, quality = 3): DecisionResult {
  return {
    provider: 'typesafe',
    model: request.model!,
    usage: { inputTokens: 80, outputTokens: 20 },
    requestId: 'native-request-1',
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        if (question.type !== 'score') {
          throw new Error('Expected scores')
        }
        const level = id === 'availability' ? availability : quality
        const low = Math.floor(level)
        const high = Math.ceil(level)
        const probabilities = Object.fromEntries(
          question.criteria.map((_, index) => [
            String(index),
            low === high
              ? Number(index === low)
              : index === low
                ? high - level
                : index === high
                  ? level - low
                  : 0
          ])
        )
        return [
          id,
          {
            type: 'score',
            score: level,
            confidence: 0.01,
            probabilities,
            legend: Object.fromEntries(
              question.criteria.map((text, index) => [String(index), text])
            )
          }
        ]
      })
    )
  }
}
const credential = async () => 'fixture-credential'

describe('direct advisory JEV rubric evaluation', () => {
  it('batches exact rubric criteria once and records native scores independently of confidence', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => result(request))
    const record = await evaluateJevRubric(input, entry, { evaluate, credential, environment: {} })
    expect(evaluate).toHaveBeenCalledTimes(1)
    const request = evaluate.mock.calls[0]![0]
    expect(request.model).toBe('jev-1.13.0')
    expect(request.state).toMatchObject({
      reference_material: {
        task: input.task,
        response: input.response,
        rubric: entry.rubric.instructions
      }
    })
    expect(Object.keys(request.questions)).toEqual(['availability', 'quality', 'c1', 'c2'])
    expect(record).toMatchObject({
      status: 'verdict',
      provider_status: 'evaluated',
      calls: 1,
      action_authorized: false,
      decision_escalation: 'never',
      evidence_scope: 'supplied_material_only',
      scores: { quality: 3, c1: 3, c2: 3 },
      usage: { inputTokens: 80, outputTokens: 20 },
      rubric: entry,
      redacted: false,
      question_version: 'jev-rubric-evaluation/1'
    })
    expect(record.answers.quality).toMatchObject({ confidence: 0.01 })
  })

  it.each(['missing', 'stale', 'conflicting', 'unverified'] as const)(
    'returns UNKNOWN before inference for declared %s evidence',
    async (status) => {
      const evaluate = vi.fn()
      const getCredential = vi.fn(credential)
      const record = await evaluateJevRubric(
        { ...input, evidence: { status, text: 'Known gap' } },
        entry,
        { evaluate, credential: getCredential, environment: {} }
      )
      expect(record).toMatchObject({
        status: 'unknown',
        provider_status: 'not_called',
        kind: status === 'conflicting' ? 'contradictory' : status,
        calls: 0,
        answers: {}
      })
      expect(record.scores).toBeUndefined()
      expect(evaluate).not.toHaveBeenCalled()
      expect(getCredential).not.toHaveBeenCalled()
    }
  )

  it.each([
    { control: 'off' as const },
    { disabled: true },
    { environment: { JEV_DECISIONS_DISABLED: '1' } }
  ])('honors per-request and host disable without inference: %j', async (off) => {
    const evaluate = vi.fn()
    const record = await evaluateJevRubric(input, entry, {
      credential,
      environment: {},
      evaluate,
      ...off
    })
    expect(record).toMatchObject({ status: 'unknown', reason: 'disabled', calls: 0, answers: {} })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('treats blank declared verified evidence as missing before inference', async () => {
    const evaluate = vi.fn()
    const record = await evaluateJevRubric(
      { ...input, evidence: { status: 'verified', text: ' ' } },
      entry,
      { evaluate, credential, environment: {} }
    )
    expect(record).toMatchObject({ status: 'unknown', kind: 'missing', calls: 0, answers: {} })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('returns UNKNOWN without quality scores below the existing availability gate', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => result(request, 2.79))
    const low = await evaluateJevRubric(input, entry, { evaluate, credential, environment: {} })
    expect(low).toMatchObject({
      status: 'unknown',
      kind: 'missing',
      reason: 'insufficient_evidence',
      calls: 1
    })
    expect(Object.keys(low.answers)).toEqual(['availability'])
    expect(low.scores).toBeUndefined()
    evaluate.mockImplementation(async (request) => result(request, 2.8))
    expect(
      await evaluateJevRubric(input, entry, { evaluate, credential, environment: {} })
    ).toMatchObject({ status: 'verdict', scores: { quality: 3 } })
  })

  it('voids malformed/missing native answers and preserves actual missing ids without a retry', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => {
      const answer = result(request)
      delete answer.answers.c2
      return answer
    })
    const record = await evaluateJevRubric(input, entry, { evaluate, credential, environment: {} })
    expect(record).toMatchObject({
      status: 'voided',
      reason: 'invalid_response',
      calls: 1,
      answers: {},
      missing_answers: ['c2']
    })
    expect(record.scores).toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('rejects another model and does not mistake a wrong model for missing answers', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => ({
      ...result(request),
      model: 'jev-preview'
    }))
    expect(
      await evaluateJevRubric(input, entry, { evaluate, credential, environment: {} })
    ).toMatchObject({ status: 'voided', reason: 'invalid_response', missing_answers: [], calls: 1 })
  })

  it('freezes the selected rubric before credential lookup and does not expose protected reference text', async () => {
    const selected = { ...entry, rubric: { ...entry.rubric } }
    const protectedInput = {
      ...input,
      response: 'Contact example@example.com or 212-555-0199. api_key=private-value'
    }
    const evaluate = vi.fn(async (request: DecisionRequest) => result(request))
    const record = await evaluateJevRubric(protectedInput, selected, {
      evaluate,
      environment: {},
      credential: async () => {
        selected.rubric.instructions = '- changed\n- different'
        return 'fixture-credential'
      }
    })
    expect(record.rubric.rubric.instructions).toBe(entry.rubric.instructions)
    expect(record.redacted).toBe(true)
    const serialized = JSON.stringify(evaluate.mock.calls)
    expect(serialized).not.toContain('example@example.com')
    expect(serialized).not.toContain('212-555-0199')
    expect(serialized).not.toContain('private-value')
    expect(JSON.stringify(record)).not.toContain('fixture-credential')
  })

  it('bounds a stalled credential lookup and never starts an inference after its deadline', async () => {
    vi.useFakeTimers()
    try {
      let release!: (key: string) => void
      const pendingCredential = new Promise<string>((resolve) => {
        release = resolve
      })
      const evaluate = vi.fn()
      const pending = evaluateJevRubric(input, entry, {
        evaluate,
        credential: () => pendingCredential,
        environment: {}
      })
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toMatchObject({
        status: 'unknown',
        kind: 'unreachable',
        reason: 'timeout',
        calls: 0
      })
      release('fixture-credential')
      await Promise.resolve()
      expect(evaluate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves private atomic records in the existing result store and reports storage failure', async () => {
    const record = await evaluateJevRubric(input, entry, { control: 'off' })
    const directory = await mkdtemp(join(tmpdir(), 'jev-rubric-record-'))
    try {
      const saved = await recordJevRubricEvaluation(new DecisionRecords(directory), record)
      expect(saved.storage.status).toBe('saved')
      const files = await readdir(directory)
      expect(files).toHaveLength(1)
      expect(JSON.parse(await readFile(join(directory, files[0]!), 'utf8'))).toEqual(saved)
      const failed = await recordJevRubricEvaluation(
        { write: vi.fn().mockRejectedValue(new Error('fixture')) },
        record
      )
      expect(failed).toMatchObject({
        storage: { status: 'failed', reason: 'record_write_failed' },
        status: 'unknown'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
