import { expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { AutomationCreate, AutomationUpdate } from '../../runtime/rpc/methods/automation-schemas'
import {
  createAutomation,
  updateAutomation,
  type AutomationDefinitionOperations
} from './automation-definition-operations'

it('creates from a session with provenance, then binds and unbinds independently', () => {
  const operations: AutomationDefinitionOperations = {
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
  const provenance = { tabId: 'creating-chat', paneKey: null }
  const request = AutomationCreate.parse({
    name: 'Briefing',
    prompt: 'Report',
    agentId: 'codex',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '0 9 * * *',
    dtstart: 1,
    createdFromSession: provenance,
    conversation: { tabId: 'must-not-bind', paneKey: null }
  })
  const routine = createAutomation(operations, {
    ...request,
    projectId: 'repo',
    workspaceMode: 'new_per_run',
    timezone: 'UTC'
  })
  expect(routine.createdFromSession).toEqual({ tabId: 'creating-chat', paneKey: null })
  expect(routine.conversation).toBeUndefined()
  const binding = { tabId: 'routine-chat', paneKey: null, sessionKey: 'session' }
  const { updates } = AutomationUpdate.parse({ id: routine.id, updates: { conversation: binding } })
  updateAutomation(operations, routine.id, updates)
  operations.state = JSON.parse(JSON.stringify(operations.state))
  expect(operations.state.automations?.[0].conversation).toEqual(binding)
  updateAutomation(operations, routine.id, { conversation: null })
  expect(operations.state.automations).toHaveLength(1)
  expect(operations.state.automations?.[0]).toMatchObject({
    conversation: null,
    createdFromSession: provenance
  })
})
