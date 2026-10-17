import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { sweepAsyncQuestionsOfExitedAgents } from './async-question-exit-sweep'

const ASK = JSON.stringify({
  delivery: 'async',
  asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [] }]
})

function row(paneKey: string, patch: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    interactivePrompt: ASK,
    stateStartedAt: 1,
    receivedAt: 1,
    updatedAt: 1,
    ...patch
  } as AgentStatusIpcPayload
}

describe('an async question whose Codex exited', () => {
  it('is dropped only on the host’s positive evidence that the agent left', async () => {
    const evidence: Record<string, unknown> = {
      'h-gone': { proof: null, tree: { kind: 'agent-gone' } },
      'h-live': { proof: { pid: 2 }, tree: { kind: 'other' } },
      'h-stopped': { proof: null, tree: { kind: 'stopped' } },
      'h-unreadable': null
    }
    const dropQuestion = vi.fn()
    await sweepAsyncQuestionsOfExitedAgents({
      statuses: () => [
        row('gone'),
        row('live'),
        row('stopped'),
        row('unreadable'),
        row('detached'),
        row('no-question', { interactivePrompt: undefined })
      ],
      handleForPane: (paneKey) => (paneKey === 'detached' ? null : `h-${paneKey}`),
      readEvidence: async (handle) =>
        (evidence[handle] ?? null) as Awaited<
          ReturnType<Parameters<typeof sweepAsyncQuestionsOfExitedAgents>[0]['readEvidence']>
        >,
      dropQuestion
    })
    expect(dropQuestion.mock.calls).toEqual([['gone']])
  })
})
