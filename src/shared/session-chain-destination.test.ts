import { describe, expect, it } from 'vitest'
import { sessionChainDestination } from './session-chain-destination'
import type { SessionChainHandoffStep } from './session-follow-up-rule'

function handoff(action: 'review' | 'edit', disposition?: 'feedback' | 'ownership-transfer') {
  return {
    kind: 'handoff',
    id: 'step_h',
    status: 'queued',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Result',
      sessionLabel: 'Result',
      recipients: [
        { employeeId: 'emp_sal', name: 'Sal', operationId: 'operation_1', delivery: 'pending' }
      ],
      action,
      ...(disposition ? { disposition } : {}),
      deliverables: { kind: 'files', paths: [] },
      includeSummary: true,
      note: 'Please take this',
      savedAt: 1
    }
  } satisfies SessionChainHandoffStep
}

describe('sessionChainDestination', () => {
  it('does not promise a return to the person for legacy plans without an ending', () => {
    expect(sessionChainDestination({ steps: [] })).toEqual({ kind: 'done' })
    expect(sessionChainDestination({ steps: [], end: 'done' })).toEqual({ kind: 'done' })
    expect(sessionChainDestination({ steps: [], end: 'me' })).toEqual({ kind: 'me' })
  })

  it('separates the requested review action from ownership disposition', () => {
    expect(sessionChainDestination({ steps: [handoff('review', 'ownership-transfer')] })).toEqual({
      kind: 'person',
      names: 'Sal'
    })
    expect(sessionChainDestination({ steps: [handoff('edit', 'feedback')] })).toEqual({
      kind: 'done'
    })
  })

  it('preserves legacy review as feedback and other legacy actions as transfers', () => {
    expect(sessionChainDestination({ steps: [handoff('review')] })).toEqual({ kind: 'done' })
    expect(sessionChainDestination({ steps: [handoff('edit')] })).toEqual({
      kind: 'person',
      names: 'Sal'
    })
  })
})
