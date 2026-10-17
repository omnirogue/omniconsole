import { describe, expect, it, vi } from 'vitest'
import type { AutomationCreateInput } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createAutomation,
  listAutomations,
  updateAutomation,
  type AutomationDefinitionOperations
} from './automation-definition-operations'

const input: AutomationCreateInput = {
  name: 'Daily',
  prompt: 'Work',
  agentId: 'codex',
  projectId: 'repo',
  workspaceMode: 'new_per_run',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1
}

function operations(): AutomationDefinitionOperations {
  return {
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
}

describe('structured decision routine persistence', () => {
  it('round-trips opted-in settings while omission retains and null removes them', () => {
    const ops = operations()
    const structuredOutput = { provider: 'typesafe', contract: 'classification.v1' } as const
    const saved = createAutomation(ops, { ...input, structuredOutput })
    ops.state = JSON.parse(JSON.stringify(ops.state))
    expect(listAutomations(ops.state)[0].structuredOutput).toEqual(structuredOutput)
    expect(updateAutomation(ops, saved.id, { name: 'Renamed' }).structuredOutput).toEqual(
      structuredOutput
    )
    expect(
      updateAutomation(ops, saved.id, { structuredOutput: undefined }).structuredOutput
    ).toEqual(structuredOutput)
    expect(updateAutomation(ops, saved.id, { structuredOutput: null })).not.toHaveProperty(
      'structuredOutput'
    )
    ops.state = JSON.parse(JSON.stringify(ops.state))
    expect(listAutomations(ops.state)[0]).not.toHaveProperty('structuredOutput')
  })

  it('does not opt in or add fields to ordinary saved routines', () => {
    const ops = operations()
    const saved = createAutomation(ops, input)
    expect(saved).not.toHaveProperty('structuredOutput')
    expect(updateAutomation(ops, saved.id, { prompt: 'Changed' })).not.toHaveProperty(
      'structuredOutput'
    )
    expect(createAutomation(ops, { ...input, structuredOutput: null })).not.toHaveProperty(
      'structuredOutput'
    )
  })

  it('validates direct persistence writes before changing the store', () => {
    const ops = operations()
    const saved = createAutomation(ops, input)
    const structuredOutput = { provider: 'typesafe', contract: 'advertising.v1' }
    expect(() =>
      createAutomation(ops, { ...input, structuredOutput } as AutomationCreateInput)
    ).toThrow('Invalid structured decision settings')
    expect(() =>
      updateAutomation(ops, saved.id, { structuredOutput } as AutomationCreateInput)
    ).toThrow('Invalid structured decision settings')
    expect(ops.state.automations).toEqual([saved])
  })
})
