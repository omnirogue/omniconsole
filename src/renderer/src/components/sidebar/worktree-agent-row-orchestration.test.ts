import { describe, expect, it } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { entryWithRuntimeOrchestration } from './worktree-agent-row-orchestration'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const paneKey = makePaneKey('tab-worker', '22222222-2222-4222-8222-222222222222')
const parentPaneKey = makePaneKey('tab-parent', '33333333-3333-4333-8333-333333333333')
const context: AgentStatusOrchestrationContext = {
  taskId: 'task-review',
  dispatchId: 'dispatch-review',
  taskTitle: 'Review the changes',
  parentPaneKey,
  orchestrationRunId: 'run-1'
}
const tab: TerminalTab = {
  id: 'tab-worker',
  worktreeId: 'folder-1',
  ptyId: null,
  title: 'Codex',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1000
}

function entry(orchestration = context): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    stateStartedAt: 1000,
    updatedAt: 1000,
    stateHistory: [],
    prompt: 'Review the changes',
    agentType: 'codex',
    connectionId: 'ssh-worker',
    worktreeId: 'folder-1',
    orchestration
  }
}

describe('runtime dispatch status in worktree agent rows', () => {
  it.each([
    [undefined, 'pending'],
    ['pending', 'dispatched'],
    ['dispatched', 'completed'],
    ['dispatched', 'failed'],
    ['dispatched', 'circuit_broken']
  ] as const)('publishes %s → %s without waiting for a hook update', (before, after) => {
    const hookEntry = entry({ ...context, dispatchStatus: before })
    for (const retained of [false, true]) {
      const rows = buildWorktreeAgentRows({
        tabs: retained ? [] : [tab],
        entries: retained ? [] : [hookEntry],
        retained: retained
          ? [
              {
                entry: hookEntry,
                tab,
                worktreeId: tab.worktreeId,
                agentType: 'codex',
                startedAt: 1000
              }
            ]
          : [],
        runtimeAgentOrchestrationByPaneKey: {
          [paneKey]: { ...context, dispatchStatus: after }
        },
        now: 2000
      })

      expect(rows).toHaveLength(1)
      expect(rows[0].entry.orchestration?.dispatchStatus).toBe(after)
      expect(rows[0].entry.orchestration?.parentPaneKey).toBe(parentPaneKey)
      expect(rows[0].entry.connectionId).toBe('ssh-worker')
      expect(rows[0].entry.state).toBe('working')
      expect(rows[0].state).toBe(retained ? 'done' : 'working')
      expect(hookEntry.orchestration?.dispatchStatus).toBe(before)
    }
  })

  it('preserves hook ownership when a terminal is reused by another dispatch', () => {
    const hookEntry = entry({ ...context, dispatchId: 'dispatch-new' })
    const merged = entryWithRuntimeOrchestration(hookEntry, {
      [paneKey]: { ...context, dispatchStatus: 'completed' }
    })

    expect(merged).toBe(hookEntry)
    expect(merged.orchestration?.dispatchStatus).toBeUndefined()
  })

  it('keeps the last observation when runtime context or its optional status is unavailable', () => {
    const hookEntry = entry({ ...context, dispatchStatus: 'dispatched' })

    expect(entryWithRuntimeOrchestration(hookEntry, undefined)).toBe(hookEntry)
    expect(entryWithRuntimeOrchestration(hookEntry, {})).toBe(hookEntry)
    expect(entryWithRuntimeOrchestration(hookEntry, { [paneKey]: context })).toBe(hookEntry)
  })

  it('reuses unchanged entries after the runtime status has been applied', () => {
    const hookEntry = entry({ ...context, dispatchStatus: 'completed' })

    expect(
      entryWithRuntimeOrchestration(hookEntry, {
        [paneKey]: { ...context, dispatchStatus: 'completed' }
      })
    ).toBe(hookEntry)
  })
})
