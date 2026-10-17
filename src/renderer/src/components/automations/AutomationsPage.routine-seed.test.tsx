// @vitest-environment happy-dom

/**
 * The routines sidebar seeds a create-draft through the store. The seed effect used to call
 * openCreateDialog unconditionally, which replaced whatever the person already had open in the
 * editor with a blank routine draft.
 */

import { act } from 'react'
import { AutomationWorkspaceField } from './AutomationWorkspaceField'
import { AutomationSessionField } from './AutomationSessionField'
import { AutomationDestinationField } from './AutomationDestinationField'
import { automationCreateHostStableKey } from './automation-create-destination'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { describe, expect, it, vi } from 'vitest'
import {
  installAutomationsPageHarness,
  mocks,
  renderPage,
  settleHostQueries
} from './automations-page-test-harness'

installAutomationsPageHarness()

const seed = { cron: '0 9 * * 1', workspaceId: 'workspace-1' }

function installSeedSpy(): ReturnType<typeof vi.fn> {
  const setSeed = vi.fn()
  mocks.state.setPendingRoutineDraftSeed = setSeed
  return setSeed
}

function draftSchedule(): string | undefined {
  return (mocks.editorDialog?.draft as { customSchedule?: string } | undefined)?.customSchedule
}

function workspaceField() {
  return AutomationWorkspaceField({
    draft: mocks.editorDialog!.draft as AutomationDraft,
    isHermesTarget: false,
    worktrees: [],
    repoMap: new Map(),
    pickerTriggerClassName: '',
    segmentedGroupClassName: '',
    segmentedItemClassName: '',
    onDraftChange: mocks.editorDialog!.onDraftChange as never
  })
}

function changeWorkspaceMode(value: string): void {
  workspaceField().props.children.props.children[0].props.onValueChange(value)
}

function chooseWorkspace(value: string): void {
  workspaceField().props.children.props.children[1].props.onValueChange(value)
}

function chooseHost(hostId: string): void {
  const field = AutomationDestinationField({ control: mocks.editorDialog!.createDestination! })
  field.props.children[0].props.onValueChange(automationCreateHostStableKey(hostId))
}

function chooseSession(value: string): void {
  const field = AutomationSessionField({
    draft: mocks.editorDialog!.draft as AutomationDraft,
    toggleGroupClassName: '',
    toggleItemClassName: '',
    onDraftChange: mocks.editorDialog!.onDraftChange as never
  })
  field.props.children.props.onValueChange(value)
}

describe('automations routine seed', () => {
  it('retains a dragged conversation and offers a daily 9 AM schedule', async () => {
    installSeedSpy()
    mocks.state.pendingRoutineDraftSeed = {
      ...seed,
      cron: '0 9 * * *',
      name: 'Check registration',
      prompt: 'Check registration on mobile',
      agentId: 'codex'
    }
    await renderPage()
    await settleHostQueries()
    expect(mocks.editorDialog?.draft).toMatchObject({
      name: 'Check registration',
      prompt: 'Check registration on mobile',
      agentId: 'codex',
      workspaceId: seed.workspaceId,
      preset: 'daily',
      time: '09:00',
      reuseSession: true
    })
  })

  it('opens the create dialog for a seed when nothing is open', async () => {
    const setSeed = installSeedSpy()
    mocks.state.pendingRoutineDraftSeed = seed
    await renderPage()
    await settleHostQueries()

    expect(mocks.editorDialog?.open).toBe(true)
    expect(draftSchedule()).toBe(seed.cron)
    expect(setSeed).toHaveBeenCalledWith(null)
  })

  it('waits instead of clobbering a dialog the person already opened', async () => {
    const setSeed = installSeedSpy()
    const { rerender } = await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    expect(mocks.editorDialog?.open).toBe(true)

    mocks.state.pendingRoutineDraftSeed = seed
    await rerender()
    await settleHostQueries()

    expect(setSeed).not.toHaveBeenCalled()
    expect(draftSchedule()).not.toBe(seed.cron)
  })
})

it('new local drafts default to reuse while an explicit fresh choice stays false', async () => {
  await renderPage()
  await settleHostQueries()
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  expect(mocks.editorDialog?.draft).toMatchObject({
    workspaceId: 'workspace-1',
    reuseSession: true
  })
  await act(async () => {
    chooseSession('fresh')
  })
  expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: false })
})

it.each(['ssh:remote', 'runtime:paired'])(
  'a routine seeded from %s keeps the fresh default',
  async (hostId) => {
    installSeedSpy()
    mocks.state.pendingRoutineDraftSeed = { ...seed, hostId }
    await renderPage()
    await settleHostQueries()
    expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: false })
  }
)
it('new-per-run keeps fresh, and an explicit fresh choice survives a workspace change', async () => {
  await renderPage()
  await settleHostQueries()
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    changeWorkspaceMode('new_per_run')
  })
  expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: false })
  await act(async () => {
    changeWorkspaceMode('existing')
  })
  expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: true })
  await act(async () => {
    chooseSession('fresh')
  })
  await act(async () => {
    mocks.editorDialog?.onDraftChange((draft) => ({
      ...(draft as object),
      workspaceId: 'another-local-workspace'
    }))
  })
  expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: false })
})

it('an explicit reuse choice survives automatic workspace-mode clearing', async () => {
  await renderPage()
  await settleHostQueries()
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    chooseSession('fresh')
  })
  await act(async () => {
    chooseSession('reuse')
  })
  await act(async () => {
    changeWorkspaceMode('new_per_run')
  })
  expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: false })
  await act(async () => {
    changeWorkspaceMode('existing')
  })
  expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: true })
})

it.each([
  ['ssh:remote', 'local', null, true],
  ['local', 'ssh:remote', null, false],
  ['ssh:remote', 'local', 'fresh', false],
  ['local', 'ssh:remote', 'reuse', true]
] as const)(
  'a %s seed moved to %s uses the selected host default unless Session is %s',
  async (seedHost, selectedHost, choice, reuseSession) => {
    installSeedSpy()
    const repos = mocks.state.repos as Repo[]
    const repo = { ...repos[0]!, id: 'ssh-repo', connectionId: 'remote' }
    const localWorktree = mocks.worktreeMap.get(seed.workspaceId) as Worktree
    const worktree = {
      ...localWorktree,
      id: 'ssh-workspace',
      repoId: repo.id,
      hostId: 'ssh:remote'
    }
    mocks.state.repos = [...repos, repo]
    mocks.repoMap.set(repo.id, repo)
    mocks.worktreeMap.set(worktree.id, worktree)
    mocks.state.worktreesByRepo = {
      ...(mocks.state.worktreesByRepo as Record<string, Worktree[]>),
      [repo.id]: [worktree]
    }
    const setups = mocks.state.projectHostSetups as ProjectHostSetup[]
    mocks.state.projectHostSetups = [
      ...setups,
      {
        ...setups[0]!,
        id: 'ssh-setup',
        projectId: 'ssh-project',
        repoId: repo.id,
        hostId: 'ssh:remote'
      }
    ]
    mocks.state.sshTargetLabels = new Map([['remote', 'Remote']])
    mocks.state.sshTargetGenerations = new Map([['remote', 1]])
    mocks.state.sshConnectionStates = new Map([['remote', { status: 'connected' }]])
    mocks.state.fetchWorktrees = vi.fn(async () => [])
    mocks.state.pendingRoutineDraftSeed = {
      ...seed,
      hostId: seedHost,
      projectId: seedHost === 'local' ? repos[0]!.id : repo.id,
      workspaceId: seedHost === 'local' ? seed.workspaceId : worktree.id
    }
    await renderPage()
    await settleHostQueries()
    expect(mocks.editorDialog?.draft).toMatchObject({ reuseSession: seedHost === 'local' })
    if (choice) {
      await act(async () => chooseSession(choice))
    }
    await act(async () => chooseHost(selectedHost))
    await act(async () => {
      mocks.editorDialog!.onProjectChange(selectedHost === 'local' ? repos[0]!.id : repo.id)
    })
    const workspaceId = selectedHost === 'local' ? seed.workspaceId : worktree.id
    await act(async () => chooseWorkspace(workspaceId))
    expect(mocks.editorDialog?.draft).toMatchObject({ workspaceId, reuseSession })
  }
)
