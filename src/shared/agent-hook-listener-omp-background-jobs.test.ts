import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

const base = {
  paneKey: PANE_KEY,
  tabId: 'tab-1',
  worktreeId: 'wt',
  env: 'production' as const,
  version: '1'
}

describe('OMP turn end with background jobs', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const agentEnd = (extra: Record<string, unknown>) =>
    normalizeHookPayload(
      state,
      'omp',
      { ...base, payload: { hook_event_name: 'agent_end', ...extra } },
      'production'
    )?.payload

  it('waits on background work while async jobs run, never plain working', () => {
    expect(agentEnd({ background_task_count: 2 })).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      backgroundTaskCount: 2,
      agentType: 'omp'
    })
  })

  it('waits on background work with no number when the job snapshot could not be read', () => {
    const payload = agentEnd({ background_tasks_unknown: true })
    expect(payload).toMatchObject({ state: 'working', workingMode: 'monitoring', agentType: 'omp' })
    expect(payload?.backgroundTaskCount).toBeUndefined()
  })

  it('is done once no job runs, or when the count is missing or malformed', () => {
    for (const extra of [
      {},
      { background_task_count: 0 },
      { background_task_count: '3' },
      { background_tasks_unknown: 'true' }
    ]) {
      const payload = agentEnd(extra)
      expect(payload?.state).toBe('done')
      expect(payload?.workingMode).toBeUndefined()
      expect(payload?.backgroundTaskCount).toBeUndefined()
    }
  })
})
