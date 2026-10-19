import { describe, expect, it, vi } from 'vitest'
import { getAutomationHubRefusal } from '../../../shared/automation-hub-authority'
import type { AutomationCreateInput } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  createAutomation,
  deleteAutomation,
  updateAutomation,
  type AutomationDefinitionOperations
} from './automation-definition-operations'

const hubTaskId = 'btk_recurring_work'
const refusal = getAutomationHubRefusal(hubTaskId) ?? ''
const linkedItem: WorkspaceLinkedItem = {
  provider: 'backoffice',
  type: 'issue',
  number: 1,
  title: 'Reply to customers',
  url: 'https://console.example.com',
  hubTaskId
}

function operations(): AutomationDefinitionOperations {
  return {
    state: {
      repos: [{ id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 }],
      projectGroups: [],
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

function input(workspaceId = 'workspace'): AutomationCreateInput {
  return {
    name: 'Customer replies',
    prompt: 'Draft customer replies',
    agentId: 'claude',
    projectId: 'repo',
    workspaceMode: 'existing',
    workspaceId,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.UTC(2026, 8, 8)
  }
}

function bindWorkspace(ops: AutomationDefinitionOperations, kind: 'git' | 'folder'): void {
  const common = {
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
  if (kind === 'git') {
    ops.state.worktreeMeta.workspace = {
      ...common,
      displayName: 'Workspace',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedWorkItem: linkedItem
    }
  } else {
    ops.state.folderWorkspaces = [
      {
        ...common,
        id: 'workspace',
        projectGroupId: 'group',
        name: 'Workspace',
        folderPath: '/workspace',
        linkedTask: linkedItem,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}

describe.each(['git', 'folder'] as const)('hub-bound %s automation definitions', (kind) => {
  it.each([true, false])('refuses creation with enabled=%s before persistence', (enabled) => {
    const ops = operations()
    bindWorkspace(ops, kind)

    expect(() => createAutomation(ops, { ...input(), enabled })).toThrow(refusal)
    expect(ops.state.automations).toEqual([])
    expect(ops.flush).not.toHaveBeenCalled()
    expect(ops.recordCreated).not.toHaveBeenCalled()
  })

  it('refuses enabling or editing a legacy definition once its workspace is bound', () => {
    const ops = operations()
    const legacy = createAutomation(ops, { ...input(), enabled: false })
    bindWorkspace(ops, kind)
    vi.mocked(ops.flush).mockClear()

    for (const updates of [
      { enabled: true },
      { rrule: 'FREQ=HOURLY' },
      { prompt: 'Send replies now' },
      { enabled: false, prompt: 'Change while disabling' }
    ]) {
      expect(() => updateAutomation(ops, legacy.id, updates)).toThrow(refusal)
    }
    expect(ops.state.automations).toEqual([legacy])
    expect(ops.flush).not.toHaveBeenCalled()
  })

  it('refuses moving a legacy definition away from its bound workspace', () => {
    const ops = operations()
    const legacy = createAutomation(ops, input())
    bindWorkspace(ops, kind)

    expect(() => updateAutomation(ops, legacy.id, { workspaceId: 'unbound' })).toThrow(refusal)
    expect(() => updateAutomation(ops, legacy.id, { workspaceMode: 'new_per_run' })).toThrow(
      refusal
    )
    expect(ops.state.automations).toEqual([legacy])
  })

  it('refuses moving an unbound definition into a bound workspace', () => {
    const ops = operations()
    const automation = createAutomation(ops, input('unbound'))
    bindWorkspace(ops, kind)

    expect(() => updateAutomation(ops, automation.id, { workspaceId: 'workspace' })).toThrow(
      refusal
    )
    expect(ops.state.automations).toEqual([automation])
  })

  it('allows pure disable and deletion of a legacy bound definition', () => {
    const ops = operations()
    const legacy = createAutomation(ops, input())
    bindWorkspace(ops, kind)
    vi.mocked(ops.flush).mockClear()

    const disabled = updateAutomation(ops, legacy.id, { enabled: false, prompt: undefined })
    expect(disabled).toMatchObject({
      enabled: false,
      prompt: legacy.prompt,
      workspaceId: legacy.workspaceId,
      rrule: legacy.rrule,
      dtstart: legacy.dtstart
    })
    expect(ops.flush).toHaveBeenCalledOnce()
    deleteAutomation(ops, legacy.id)
    expect(ops.state.automations).toEqual([])
    expect(ops.flush).toHaveBeenCalledTimes(2)
  })

  it('refuses retrying a creation key whose saved workspace became bound', () => {
    const ops = operations()
    const legacy = createAutomation(ops, { ...input(), creationKey: 'retry' })
    bindWorkspace(ops, kind)

    expect(() => createAutomation(ops, { ...input('unbound'), creationKey: 'retry' })).toThrow(
      refusal
    )
    expect(ops.state.automations).toEqual([legacy])
  })
})

it('preserves unbound recurrence creation, editing, enabling and retry behavior', () => {
  const ops = operations()
  const automation = createAutomation(ops, { ...input(), enabled: false, creationKey: 'ad-hoc' })

  const updated = updateAutomation(ops, automation.id, { enabled: true, rrule: 'FREQ=HOURLY' })
  expect(updated).toMatchObject({ enabled: true, rrule: 'FREQ=HOURLY' })
  expect(createAutomation(ops, { ...input(), creationKey: 'ad-hoc' })).toEqual(updated)
  expect(ops.state.automations).toEqual([updated])
  expect(ops.recordCreated).toHaveBeenCalledOnce()
  expect(ops.flush).toHaveBeenCalledTimes(2)
})

it('refuses folder:<id> create and updates using persisted raw folder ids', () => {
  const ops = operations()
  const legacy = createAutomation(ops, input('folder:workspace'))
  const unbound = createAutomation(ops, input('unbound'))
  bindWorkspace(ops, 'folder')
  vi.mocked(ops.flush).mockClear()

  expect(() => createAutomation(ops, { ...input('folder:workspace'), enabled: false })).toThrow(
    refusal
  )
  expect(() => updateAutomation(ops, legacy.id, { prompt: 'Different reply' })).toThrow(refusal)
  expect(() => updateAutomation(ops, legacy.id, { workspaceId: 'unbound' })).toThrow(refusal)
  expect(() => updateAutomation(ops, unbound.id, { workspaceId: 'folder:workspace' })).toThrow(
    refusal
  )
  expect(ops.state.automations).toEqual([legacy, unbound])
  expect(ops.flush).not.toHaveBeenCalled()
})

it('refuses canonical-only hub binding on the automation execution host', () => {
  const ops = operations()
  ops.state.repos[0].connectionId = 'owner'
  const legacy = createAutomation(ops, input())
  bindWorkspace(ops, 'git')
  const hostId = 'ssh:owner'
  const identity = canonicalWorktreeIdentity({
    executionHostId: hostId,
    worktreeId: 'workspace',
    instanceId: 'owner-instance'
  })
  ops.state.worktreeMetaByIdentity = {
    [identity]: { ...ops.state.worktreeMeta.workspace, hostId }
  }
  ops.state.worktreeIdentityAliases = {
    [composeWorktreeHostIdentity(hostId, 'workspace')]: [identity]
  }
  ops.state.worktreeMeta.workspace = {
    ...ops.state.worktreeMeta.workspace,
    hostId: 'local',
    linkedWorkItem: null
  }

  expect(() => createAutomation(ops, input())).toThrow(refusal)
  expect(() => updateAutomation(ops, legacy.id, { prompt: 'Different reply' })).toThrow(refusal)
  expect(ops.state.automations).toEqual([legacy])
})

it('ignores another host binding at the same locator for an unbound owner', () => {
  const ops = operations()
  bindWorkspace(ops, 'git')
  ops.state.worktreeMeta.workspace.hostId = 'ssh:other'
  const identity = canonicalWorktreeIdentity({
    executionHostId: 'local',
    worktreeId: 'workspace',
    instanceId: 'local-instance'
  })
  ops.state.worktreeMetaByIdentity = {
    [identity]: { ...ops.state.worktreeMeta.workspace, hostId: 'local', linkedWorkItem: null }
  }
  ops.state.worktreeIdentityAliases = {
    [composeWorktreeHostIdentity('local', 'workspace')]: [identity]
  }

  const automation = createAutomation(ops, input())
  const updated = updateAutomation(ops, automation.id, { rrule: 'FREQ=HOURLY' })
  expect(updated.rrule).toBe('FREQ=HOURLY')
  expect(ops.state.automations).toEqual([updated])
  expect(ops.flush).toHaveBeenCalledTimes(2)
})
