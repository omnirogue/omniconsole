import { describe, expect, it } from 'vitest'

import { applyDeliveryMessages } from './build-review-messages'
import { createPipelineSnapshot } from './build-review-pipeline-state'

function pipelineWithBuilder() {
  const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'x' } as never)
  pipeline.builder.status = 'running'
  pipeline.builder.dispatchId = 'ctx_1'
  pipeline.builder.terminalHandle = 'term_1'
  return pipeline
}

describe('applyDeliveryMessages', () => {
  it("drops the builder's open question when its worker_done arrives", () => {
    const pipeline = pipelineWithBuilder()
    applyDeliveryMessages(pipeline, [
      {
        id: 'msg_q',
        from_handle: 'term_1',
        type: 'question',
        subject: 'Question',
        body: 'route the backend failures?',
        payload: JSON.stringify({ dispatchId: 'ctx_1' })
      } as never
    ])
    expect(pipeline.pendingQuestion?.messageId).toBe('msg_q')
    applyDeliveryMessages(pipeline, [
      {
        id: 'msg_d',
        from_handle: 'term_1',
        type: 'worker_done',
        subject: 'done',
        body: 'changed',
        payload: JSON.stringify({ dispatchId: 'ctx_1', outcome: 'failed', filesModified: 'a.ts' })
      } as never
    ])
    expect(pipeline.pendingQuestion).toBeNull()
    expect(pipeline.builder.status).toBe('failed')
    expect(pipeline.events.some((e) => e.text.includes('superseded by worker_done'))).toBe(true)
  })
  it('ignores a prior dispatch even if its terminal matches the current worker', () => {
    const pipeline = pipelineWithBuilder()
    applyDeliveryMessages(pipeline, [
      {
        id: 'stale',
        from_handle: 'term_1',
        type: 'worker_done',
        payload: JSON.stringify({ dispatchId: 'ctx_old', outcome: 'succeeded' })
      } as never
    ])
    expect(pipeline.builder.status).toBe('running')
    expect(pipeline.builder.report).toBeNull()
  })

  it('does not treat a missing outcome as a successful review', () => {
    const pipeline = pipelineWithBuilder()
    applyDeliveryMessages(pipeline, [
      {
        id: 'missing',
        from_handle: 'term_1',
        type: 'worker_done',
        payload: JSON.stringify({ dispatchId: 'ctx_1' })
      } as never
    ])
    expect(pipeline.builder.status).toBe('failed')
  })
})
