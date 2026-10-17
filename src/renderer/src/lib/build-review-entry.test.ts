import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'

const mocks = vi.hoisted(() => ({
  targets: {} as Record<string, string | undefined>,
  webSession: false,
  state: {
    activeWorktreeId: 'local-wt' as string | null,
    settings: { activeRuntimeEnvironmentId: undefined as string | undefined },
    buildReview: { openStartDialog: vi.fn(), select: vi.fn() },
    openBuildReviewPage: vi.fn()
  },
  create: vi.fn(),
  update: vi.fn(),
  title: vi.fn(),
  reveal: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: (_state: unknown, id: string) => mocks.targets[id]
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: () => mocks.webSession
}))
vi.mock('./local-workflow-conversation', () => ({
  createLocalWorkflowConversation: mocks.create,
  updateLocalWorkflowConversation: mocks.update,
  titleLocalWorkflowConversation: mocks.title
}))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorkspace: mocks.reveal }))

import { anchorBuildReviewRun, canHoldBuildReviewTab, openBuildReview } from './build-review-entry'

const pipeline = { id: 'brp_1', objective: 'Add search' } as BuildReviewPipelineSnapshot

beforeEach(() => {
  vi.clearAllMocks()
  mocks.targets = {
    'local-wt': 'local',
    'ssh-wt': 'ssh:box',
    'runtime-wt': 'runtime:env-1',
    'pending-wt': undefined
  }
  mocks.webSession = false
  mocks.state.activeWorktreeId = 'local-wt'
  mocks.create.mockReturnValue('tab-new')
  mocks.reveal.mockReturnValue({ primaryTabId: null })
})

describe('where Build + Review can open as a tab', () => {
  it('holds a tab in local and SSH workspaces only', () => {
    expect(canHoldBuildReviewTab('local-wt')).toBe(true)
    expect(canHoldBuildReviewTab('ssh-wt')).toBe(true)
    expect(canHoldBuildReviewTab('runtime-wt')).toBe(false)
    expect(canHoldBuildReviewTab('pending-wt')).toBe(false)
  })

  it('never holds a tab while a web runtime session owns this window', () => {
    mocks.webSession = true
    expect(canHoldBuildReviewTab('local-wt')).toBe(false)
    expect(canHoldBuildReviewTab('ssh-wt')).toBe(false)
  })
})

describe('openBuildReview', () => {
  it('opens a tab with the prompt in the active workspace without re-activating it', () => {
    expect(openBuildReview('local-wt', { prompt: 'Fix the retry' })).toBe('tab-new')
    expect(mocks.create).toHaveBeenCalledWith('local-wt', 'build-review')
    expect(mocks.update).toHaveBeenCalledWith('local-wt', 'tab-new', { prompt: 'Fix the retry' })
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.state.buildReview.openStartDialog).not.toHaveBeenCalled()
  })

  it('reveals an SSH workspace from another row before opening its tab', () => {
    expect(openBuildReview('ssh-wt')).toBe('tab-new')
    expect(mocks.reveal).toHaveBeenCalledWith('ssh-wt', { providesInitialSurface: true })
    expect(mocks.create).toHaveBeenCalledWith('ssh-wt', 'build-review')
    expect(mocks.reveal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]
    )
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each([
    ['a runtime environment', 'runtime-wt'],
    ['an unresolved host', 'pending-wt']
  ])('asks for a workspace in %s, keeping the prompt', (_label, id) => {
    expect(openBuildReview(id, { prompt: 'Fix it' })).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.state.buildReview.openStartDialog).toHaveBeenCalledWith(id, 'Fix it')
  })

  it('asks for a workspace when none is active or it cannot be shown', () => {
    expect(openBuildReview(null)).toBeNull()
    expect(mocks.state.buildReview.openStartDialog).toHaveBeenLastCalledWith(undefined, undefined)
    mocks.reveal.mockReturnValue(false)
    expect(openBuildReview('ssh-wt')).toBeNull()
    expect(mocks.state.buildReview.openStartDialog).toHaveBeenLastCalledWith('ssh-wt', undefined)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('falls back to the dialog when the tab cannot be created', () => {
    mocks.create.mockImplementation(() => {
      throw new Error('Choose a local or SSH workspace for Build + Review.')
    })
    expect(openBuildReview('local-wt')).toBeNull()
    expect(mocks.state.buildReview.openStartDialog).toHaveBeenCalledWith('local-wt', undefined)
  })
})

describe('anchorBuildReviewRun', () => {
  it('gives a dialog-started run its own tab in the picked SSH workspace', () => {
    expect(anchorBuildReviewRun('ssh-wt', pipeline)).toBe('tab-new')
    expect(mocks.reveal).toHaveBeenCalledWith('ssh-wt', { providesInitialSurface: true })
    expect(mocks.update).toHaveBeenCalledWith('ssh-wt', 'tab-new', {
      buildReviewPipelineId: 'brp_1',
      prompt: 'Add search'
    })
    expect(mocks.title).toHaveBeenCalledWith('tab-new', 'Add search')
    expect(mocks.state.openBuildReviewPage).not.toHaveBeenCalled()
  })

  it.each([
    ['a runtime environment', 'runtime-wt'],
    ['no picked workspace', undefined]
  ])('leaves the run on the page for %s', (_label, id) => {
    expect(anchorBuildReviewRun(id, pipeline)).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.state.buildReview.select).toHaveBeenCalledWith('brp_1')
    expect(mocks.state.openBuildReviewPage).toHaveBeenCalledOnce()
  })

  it('shows a started run on the page, never a start failure, when the tab cannot be made', () => {
    mocks.create.mockImplementation(() => {
      throw new Error('host changed')
    })
    expect(anchorBuildReviewRun('local-wt', pipeline)).toBeNull()
    expect(mocks.state.buildReview.select).toHaveBeenCalledWith('brp_1')
    expect(mocks.state.openBuildReviewPage).toHaveBeenCalledOnce()
  })
})
