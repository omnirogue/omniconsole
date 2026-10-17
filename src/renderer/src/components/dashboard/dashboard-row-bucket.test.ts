import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'

const ASYNC_ASK = JSON.stringify({
  delivery: 'async',
  asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [{ label: 'Red' }] }]
})
const SELECTOR_ASK = JSON.stringify({
  questions: [{ question: 'Ship now?', multiSelect: false, options: [{ label: 'Yes' }] }]
})

function project(state: AgentStatusEntry['state'], entry: Partial<AgentStatusEntry>) {
  return dashboardRowBucketProjection({
    paneKey: 'tab-1:leaf-1',
    state,
    startedAt: 1,
    entry: { state, stateStartedAt: 5, updatedAt: 5, ...entry } as AgentStatusEntry
  })
}

describe('a Codex async question in Needs you', () => {
  it("puts a finished turn that asked one in the person's attention", () => {
    expect(project('done', { interactivePrompt: ASYNC_ASK })).toMatchObject({
      dotState: 'waiting',
      bucket: 'attention'
    })
  })

  it('also while only its children still run', () => {
    expect(
      project('working', { workingMode: 'monitoring', interactivePrompt: ASYNC_ASK })
    ).toMatchObject({ dotState: 'waiting', workingMode: undefined, bucket: 'attention' })
  })

  it('leaves a finished turn without one, or with a selector question, finished', () => {
    expect(project('done', {}).dotState).toBe('done')
    expect(project('done', { interactivePrompt: SELECTOR_ASK }).dotState).toBe('done')
    expect(project('working', { interactivePrompt: ASYNC_ASK }).dotState).toBe('working')
  })
})
