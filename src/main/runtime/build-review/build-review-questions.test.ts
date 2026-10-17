import { describe, expect, it } from 'vitest'
import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import {
  answerPipelineQuestion,
  BuildReviewWorkerRegistry,
  pipelineQuestionFor,
  setPipelineQuestion
} from './build-review-questions'
import type { WorkerUnitLike } from './build-review-worker-registry'

const worker = (dispatchId: string): WorkerUnitLike => ({
  role: 'reviewer',
  choice: { agent: 'claude' },
  status: 'running',
  taskId: null,
  dispatchId,
  terminalHandle: null,
  report: null,
  error: null
})

const question = (messageId: string) => ({
  messageId,
  role: 'reviewer',
  question: `Which file for ${messageId}?`,
  options: [],
  askedAt: '2026-09-22T00:00:00Z'
})

describe('Build + Review worker questions', () => {
  it('keeps one open question per reviewer and answers them one at a time', () => {
    const pipeline = { pendingQuestion: null } as unknown as BuildReviewPipelineSnapshot
    const [a, b] = [worker('ctx_2'), worker('ctx_3')]
    setPipelineQuestion(pipeline, a, question('m1'))
    setPipelineQuestion(pipeline, b, question('m2'))
    expect(pipeline.pendingQuestions?.map((open) => open.dispatchId)).toEqual(['ctx_2', 'ctx_3'])
    expect(pipeline.pendingQuestion?.messageId).toBe('m1')
    expect(pipelineQuestionFor(pipeline, b)?.messageId).toBe('m2')
    answerPipelineQuestion(pipeline, 'm1')
    expect(pipelineQuestionFor(pipeline, a)).toBeNull()
    expect(pipeline.pendingQuestion?.messageId).toBe('m2')
    setPipelineQuestion(pipeline, b, null)
    expect(pipeline.pendingQuestion).toBeNull()
    expect(pipeline.pendingQuestions).toEqual([])
  })

  it('stores a run registry question on the pipeline the page reads', () => {
    const pipeline = { pendingQuestion: null } as unknown as BuildReviewPipelineSnapshot
    const registry = new BuildReviewWorkerRegistry(pipeline)
    const target = registry.asMailboxTarget(() => undefined)
    target.setPendingQuestion(worker('ctx_4'), question('m3'))
    expect(pipeline.pendingQuestion?.dispatchId).toBe('ctx_4')
    answerPipelineQuestion(pipeline, 'm3')
    expect(target.pendingQuestionFor(worker('ctx_4'))).toBeNull()
  })
})
