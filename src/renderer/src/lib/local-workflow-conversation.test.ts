import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

const mocks = vi.hoisted(() => ({
  state: {
    tabsByWorktree: {} as Record<string, Partial<TerminalTab>[]>,
    unifiedTabsByWorktree: {} as Record<string, unknown[]>,
    activeGroupIdByWorktree: {} as Record<string, string>,
    groupsByWorktree: {} as Record<string, { id: string; activeTabId?: string }[]>,
    settings: {},
    createTab: vi.fn(),
    setTabCustomTitle: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveView: vi.fn()
  },
  target: 'local' as string | undefined,
  /** Translations by key; anything missing falls back to English. */
  labels: {} as Record<string, string>
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state, setState: vi.fn() } }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => mocks.target
}))
vi.mock('./workspace-session', () => ({ buildWorkspaceSessionPayload: vi.fn() }))
vi.mock('./workspace-session-host-persistence', () => ({
  persistWorkspaceSessionByHost: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, english: string) => mocks.labels[key] ?? english
}))

import { useAppStore } from '@/store'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import { createLocalWorkflowAuditDraft } from '../../../shared/workflow-audit-draft'
import { workflowAnchorKind } from '@/components/local-workflows/workflow-presets'
import {
  createLocalWorkflowConversation,
  localWorkflowTitleFromPrompt,
  prepareLocalWorkflowTurn,
  titleLocalWorkflowConversation
} from './local-workflow-conversation'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.target = 'local'
  mocks.labels = {}
  mocks.state.tabsByWorktree = {}
  mocks.state.groupsByWorktree = { 'worktree-1': [{ id: 'group-1' }] }
  mocks.state.createTab.mockReturnValue({ id: 'tab-new' })
})

describe('workflow conversation titles', () => {
  it('folds the request onto one line and cuts it near 48 characters', () => {
    expect(localWorkflowTitleFromPrompt('  Is the\n retry   safe?  ')).toBe('Is the retry safe?')
    const long = 'Find every place where the checkout retry path can charge a card twice'
    const title = localWorkflowTitleFromPrompt(long)
    expect(title).toBe(`${long.slice(0, 47).trimEnd()}…`)
    expect(title!.length).toBeLessThanOrEqual(48)
    expect(localWorkflowTitleFromPrompt('   ')).toBeUndefined()
  })

  it('opens a new workflow tab titled with the preset name', () => {
    expect(createLocalWorkflowConversation('worktree-1', 'build-review')).toBe('tab-new')
    expect(mocks.state.createTab).toHaveBeenCalledWith(
      'worktree-1',
      'group-1',
      undefined,
      expect.objectContaining({ localWorkflow: { preset: 'build-review', prompt: '' } })
    )
    expect(mocks.state.setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Build + Review', {
      origin: 'generated'
    })
  })

  it('refuses a workspace that is not local', () => {
    mocks.target = 'ssh:host'
    expect(() => createLocalWorkflowConversation('worktree-1', 'council')).toThrow(
      'Choose a local workspace for this workflow.'
    )
    expect(mocks.state.createTab).not.toHaveBeenCalled()
  })

  it('creates Audit as a local discover anchor with its own draft and title', () => {
    createLocalWorkflowConversation('worktree-1', 'audit')
    const anchor = mocks.state.createTab.mock.calls[0][3].localWorkflow
    expect(anchor.preset).toBe('discover')
    expect(anchor.draft.audit).toEqual({ version: 1, sourceFile: '', format: 'sources-jsonl' })
    expect(anchor.draft.runsOn).toBe('local')
    expect(anchor.draft.access).toBe('frozen')
    expect(anchor.draft.graph).toBeUndefined()
    expect(workflowAnchorKind(anchor)).toBe('audit')
    expect(mocks.state.setTabCustomTitle).toHaveBeenCalledWith('tab-new', 'Audit', {
      origin: 'generated'
    })
  })

  it('opens Build + Review in an SSH workspace, and only Build + Review', () => {
    mocks.target = 'ssh:host'
    expect(createLocalWorkflowConversation('worktree-1', 'build-review')).toBe('tab-new')
    for (const kind of [
      'discover',
      'audit',
      'investigate',
      'decide',
      'find',
      'improve',
      'custom'
    ] as const) {
      expect(() => createLocalWorkflowConversation('worktree-1', kind)).toThrow(
        'Choose a local workspace for this workflow.'
      )
    }
    expect(mocks.state.createTab).toHaveBeenCalledTimes(1)
  })

  it.each([['runtime:env-1'], [undefined]])('refuses Build + Review for target %s', (target) => {
    mocks.target = target
    expect(() => createLocalWorkflowConversation('worktree-1', 'build-review')).toThrow(
      'Choose a local or SSH workspace for Build + Review.'
    )
    expect(mocks.state.createTab).not.toHaveBeenCalled()
  })

  it('retitles a started run from its request but keeps a name the person chose', () => {
    mocks.state.tabsByWorktree = {
      'worktree-1': [
        { id: 'tab-1', customTitle: 'Council', localWorkflow: { preset: 'council', prompt: '' } },
        { id: 'tab-2', customTitle: 'My review', localWorkflow: { preset: 'council', prompt: '' } }
      ]
    }
    titleLocalWorkflowConversation('tab-1', 'Is the retry safe?')
    expect(mocks.state.setTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Is the retry safe?', {
      origin: 'generated'
    })
    titleLocalWorkflowConversation('tab-2', 'Is the retry safe?')
    expect(mocks.state.setTabCustomTitle).toHaveBeenCalledTimes(1)
  })

  it('retitles a tab still named after its preset in English or the current language', () => {
    mocks.labels['localWorkflow.preset.council'] = 'Consejo'
    mocks.state.tabsByWorktree = {
      'worktree-1': [
        { id: 'tab-1', customTitle: 'Council', localWorkflow: { preset: 'council', prompt: '' } },
        { id: 'tab-2', customTitle: 'Consejo', localWorkflow: { preset: 'council', prompt: '' } }
      ]
    }
    titleLocalWorkflowConversation('tab-1', 'Is the retry safe?')
    titleLocalWorkflowConversation('tab-2', 'Is the retry safe?')
    expect(mocks.state.setTabCustomTitle).toHaveBeenCalledTimes(2)
  })
})

describe('next workflow turn', () => {
  it('keeps Audit identity and the selected source when running again', () => {
    const draft = createLocalWorkflowAuditDraft('Old question')
    draft.audit!.sourceFile = '/corpus/records.jsonl'
    const source = {
      id: 'tab-1',
      worktreeId: 'worktree-1',
      localWorkflow: { preset: 'discover', prompt: draft.prompt, draft }
    } as TerminalTab
    mocks.state.tabsByWorktree = {
      'worktree-1': [{ id: 'tab-new', localWorkflow: { preset: 'discover', prompt: '' } }]
    }
    prepareLocalWorkflowTurn(source, 'Next question')
    const update = vi.mocked(useAppStore.setState).mock.calls[0][0] as unknown as (
      state: typeof mocks.state
    ) => { tabsByWorktree: Record<string, Partial<TerminalTab>[]> }
    const anchor = update(mocks.state).tabsByWorktree['worktree-1'][0].localWorkflow!
    expect(workflowAnchorKind(anchor)).toBe('audit')
    expect(anchor.draft!.audit!.sourceFile).toBe('/corpus/records.jsonl')
    expect(anchor.draft!.prompt).toBe('Next question')
    expect(anchor.executionId).toBeUndefined()
  })

  it('copies the last draft with the new question but without a hidden output file', () => {
    const draft = { ...createLocalWorkflowDraft('council', 'Old question'), outputFileName: 'PLAN' }
    const source = {
      id: 'tab-1',
      worktreeId: 'worktree-1',
      localWorkflow: { preset: 'council', prompt: 'Old question', draft }
    } as TerminalTab
    mocks.state.tabsByWorktree = {
      'worktree-1': [{ id: 'tab-new', localWorkflow: { preset: 'council', prompt: '' } }]
    }
    expect(prepareLocalWorkflowTurn(source, 'Next question')).toBe('tab-new')
    const update = vi.mocked(useAppStore.setState).mock.calls[0][0] as unknown as (
      state: typeof mocks.state
    ) => { tabsByWorktree: Record<string, Partial<TerminalTab>[]> }
    const copied = update(mocks.state).tabsByWorktree['worktree-1'][0].localWorkflow?.draft
    expect(copied?.prompt).toBe('Next question')
    expect(copied).not.toHaveProperty('outputFileName')
    expect(draft.outputFileName).toBe('PLAN')
  })
})
