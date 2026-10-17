import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import {
  createTerminalTabAgentTemplateActions,
  pendingTabAgentTemplate
} from './terminal-tab-agent-template'

const record = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }

function harness(initial: Partial<AppState>) {
  let state = { tabsByWorktree: {}, unifiedTabsByWorktree: {}, ...initial } as AppState
  const set = ((update: (s: AppState) => Partial<AppState>) => {
    state = { ...state, ...update(state) }
  }) as Parameters<typeof createTerminalTabAgentTemplateActions>[0]
  return { actions: createTerminalTabAgentTemplateActions(set), state: () => state }
}

describe('setTabAgentTemplate', () => {
  it('records on the terminal tab', () => {
    const { actions, state } = harness({
      tabsByWorktree: {
        w: [{ id: 'tab-1', worktreeId: 'w' } as AppState['tabsByWorktree'][string][number]]
      }
    })
    actions.setTabAgentTemplate('tab-1', record)
    expect(state().tabsByWorktree.w?.[0]?.agentTemplate).toEqual(record)
  })

  it('records on a structured agent-session tab', () => {
    const { actions, state } = harness({
      unifiedTabsByWorktree: {
        w: [
          {
            id: 'structured-agent-session-s1',
            contentType: 'agent-session'
          } as AppState['unifiedTabsByWorktree'][string][number]
        ]
      }
    })
    actions.setTabAgentTemplate('structured-agent-session-s1', record)
    expect(state().unifiedTabsByWorktree.w?.[0]?.agentTemplate).toEqual(record)
  })

  it('holds a record for a structured tab the mirror has not created yet', () => {
    const { actions } = harness({})
    actions.setTabAgentTemplate('structured-agent-session-later', record)
    expect(pendingTabAgentTemplate('structured-agent-session-later')).toEqual(record)
  })
})
