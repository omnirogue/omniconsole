import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createAutomation,
  updateAutomation,
  listAutomations,
  type AutomationDefinitionOperations
} from './automation-definition-operations'

describe('automation launch preference persistence', () => {
  it('round-trips a create, retains omitted preferences and clears on null', () => {
    const ops: AutomationDefinitionOperations = {
      state: {
        repos: [{ id: 'repo', path: '/repo' }],
        projectHostSetups: [],
        folderWorkspaces: [],
        worktreeMeta: {},
        sshTargets: [],
        automations: [],
        automationRuns: []
      } as unknown as PersistedState,
      storageAuthority: 'desktop',
      flush: vi.fn(),
      recordCreated: vi.fn()
    }
    const launchPreferences = { model: 'gpt-6-astra', effort: 'xhigh', codexAccountId: 'a' }
    const saved = createAutomation(ops, {
      name: 'Daily',
      prompt: 'Work',
      agentId: 'codex',
      projectId: 'repo',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1,
      launchPreferences
    })
    ops.state = JSON.parse(JSON.stringify(ops.state))
    expect(listAutomations(ops.state)[0].launchPreferences).toEqual(launchPreferences)
    expect(updateAutomation(ops, saved.id, { name: 'Renamed' }).launchPreferences).toEqual(
      launchPreferences
    )
    updateAutomation(ops, saved.id, { launchPreferences: null })
    ops.state = JSON.parse(JSON.stringify(ops.state))
    expect(listAutomations(ops.state)[0].launchPreferences).toBeUndefined()
  })
})
