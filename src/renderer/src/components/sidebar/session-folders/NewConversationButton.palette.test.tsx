/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { fileLaunchInFolder } from '@/lib/pending-folder-launches'
import { NewConversationButton } from './NewConversationButton'
import {
  launchManifestFor,
  pickFromLaunchManifest,
  useLaunchContext,
  withLaunchTemplate
} from './new-conversation/launch-context'
import { useLaunchReview } from '@/components/launch-review/launch-review-store'

// The palette and palette drops go through the toolbar "+"'s own launcher: the same
// `start(withLaunchTemplate(pick, target, local))` its menu rows call.

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: false,
  ownerCurrent: true,
  loadingWorktrees: new Set<string | null>(),
  folderStarting: false,
  toolbarStarting: false,
  /** A toolbar start keeps `starting` true until the test settles it. */
  holdToolbarStart: false,
  calls: [] as { worktreeId: string | null; folder: boolean }[],
  launched: undefined as ((tabId: string) => void) | undefined,
  capabilityWorktrees: [] as (string | null)[]
}))

vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (
      selector: (state: { activeWorktreeId: string; settings: Record<string, unknown> }) => unknown
    ) => selector({ activeWorktreeId: 'active-workspace', settings: {} }),
    {
      getState: () => ({
        activeWorktreeId: 'active-workspace',
        settings: { defaultTuiAgent: 'claude' }
      }),
      subscribe: () => () => {}
    }
  )
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: (worktreeId: string | null) => {
    mocks.capabilityWorktrees.push(worktreeId)
    const claude = { id: 'claude', label: 'Claude', status: 'usable', models: [] }
    return {
      loading: mocks.loading || mocks.loadingWorktrees.has(worktreeId),
      capabilities: [claude],
      usable: [claude],
      rates: {},
      refresh: vi.fn().mockResolvedValue([]),
      readCurrent: () => [claude]
    }
  }
}))
vi.mock('@/hooks/useAccountCapacityRows', () => ({ useAccountCapacityRows: () => [] }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' }),
  getAgentDetectionTargetKeyForWorktree: () => 'local'
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'scope' }))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: vi.fn(),
  useCompaniesRead: () => ({ data: undefined, loading: false, error: null })
}))
vi.mock('./new-conversation/launcher-target', () => ({
  useLauncherTargets: () => undefined,
  rememberLauncherCompany: vi.fn(),
  openLauncherAccounts: vi.fn()
}))
vi.mock('./new-conversation/use-conversation-launch', () => ({
  useConversationLaunch: (input: {
    worktreeId: string | null
    onLaunched?: (tabId: string) => void
  }) => {
    if (input.onLaunched) {
      mocks.launched = input.onLaunched
    }
    return {
      captureOwner: () => () => mocks.ownerCurrent,
      start: (pick: unknown) => {
        mocks.calls.push({ worktreeId: input.worktreeId, folder: Boolean(input.onLaunched) })
        if (!input.onLaunched && mocks.holdToolbarStart) {
          mocks.toolbarStarting = true
        }
        mocks.start(pick)
      },
      starting: input.onLaunched ? mocks.folderStarting : mocks.toolbarStarting,
      launchError: ''
    }
  }
}))
vi.mock('@/lib/pending-folder-launches', () => ({ fileLaunchInFolder: vi.fn() }))

function toolbarPlus() {
  return (
    <TooltipProvider>
      <NewConversationButton palette />
    </TooltipProvider>
  )
}

beforeEach(() => {
  useLaunchReview.getState().close()
  mocks.loading = false
  mocks.ownerCurrent = true
  mocks.loadingWorktrees.clear()
  mocks.folderStarting = false
  mocks.toolbarStarting = false
  mocks.holdToolbarStart = false
  mocks.calls.length = 0
  mocks.start.mockClear()
  mocks.error.mockClear()
  mocks.info.mockClear()
  mocks.capabilityWorktrees.length = 0
  vi.mocked(fileLaunchInFolder).mockClear()
  useLaunchContext.setState({ target: undefined, pendingLaunch: undefined })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('a palette click starts the template-wrapped pick the menu row would start', () => {
  render(toolbarPlus())
  fireEvent.click(screen.getByRole('button', { name: 'Launch Claude here' }))
  // Desktop default: the "+" launches at the work root (no worktree), locally.
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
    withLaunchTemplate({ agent: 'claude' }, null, true)
  )
})

it('a row drop waits for the target availability, then launches once in that workspace', () => {
  mocks.loading = true
  const { rerender } = render(toolbarPlus())
  act(() => {
    useLaunchContext.getState().requestLaunch({ agent: 'codex' }, undefined, {
      kind: 'workspace',
      worktreeId: 'dropped-workspace'
    })
  })
  expect(mocks.capabilityWorktrees.at(-1)).toBe('dropped-workspace')
  expect(mocks.start).not.toHaveBeenCalled()
  mocks.loading = false
  rerender(toolbarPlus())
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
    withLaunchTemplate({ agent: 'codex' }, 'dropped-workspace', true)
  )
  expect(useLaunchContext.getState().pendingLaunch).toBeUndefined()
  rerender(toolbarPlus())
  expect(mocks.start).toHaveBeenCalledOnce()
})

it('a folder drop is started by that folder’s own "+", which files the tab in the folder', () => {
  const { rerender } = render(<NewConversationButton folder={{ id: 'other', name: 'Other' }} />)
  act(() => useLaunchContext.getState().requestLaunch({ agent: 'claude' }, 'folder-1'))
  expect(mocks.start).not.toHaveBeenCalled()
  rerender(<NewConversationButton folder={{ id: 'folder-1', name: 'Folder' }} />)
  // Why no start yet: a folder launch is reviewed first, listing the folder it is filed in.
  expect(mocks.start).not.toHaveBeenCalled()
  const review = useLaunchReview.getState().request
  expect(review?.manifest.folder).toEqual({ id: 'folder-1', name: 'Folder' })
  act(() => {
    useLaunchReview.getState().close()
    review?.onStart(review.manifest, [])
  })
  const manifest = launchManifestFor({ agent: 'claude' }, null, true, {
    id: 'folder-1',
    name: 'Folder'
  })
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
    pickFromLaunchManifest({ agent: 'claude' }, manifest)
  )
  act(() => mocks.launched?.('new-tab'))
  expect(fileLaunchInFolder).toHaveBeenCalledExactlyOnceWith('new-tab', 'folder-1')
})

it('the toolbar "+" never starts a folder drop', () => {
  render(toolbarPlus())
  act(() => useLaunchContext.getState().requestLaunch({ agent: 'claude' }, 'folder-1'))
  expect(mocks.start).not.toHaveBeenCalled()
  expect(useLaunchContext.getState().pendingLaunch?.folderId).toBe('folder-1')
})

it('a drop whose target never loads is dropped with a message, not silently', () => {
  vi.useFakeTimers()
  mocks.loading = true
  render(toolbarPlus())
  act(() => {
    useLaunchContext.getState().requestLaunch({ agent: 'codex' }, undefined, {
      kind: 'workspace',
      worktreeId: 'dropped-workspace'
    })
  })
  act(() => {
    vi.advanceTimersByTime(20_000)
  })
  expect(mocks.error).toHaveBeenCalledWith(
    'Cannot launch here. The workspace or its agents are unavailable.'
  )
  expect(useLaunchContext.getState().pendingLaunch).toBeUndefined()
  expect(useLaunchContext.getState().target).toBeUndefined()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('cancels a waiting drop when its launcher leaves the surface', () => {
  mocks.loading = true
  const { unmount } = render(toolbarPlus())
  act(() => {
    useLaunchContext.getState().requestLaunch({ agent: 'codex' }, undefined, {
      kind: 'workspace',
      worktreeId: 'dropped-workspace'
    })
  })
  unmount()
  expect(useLaunchContext.getState().pendingLaunch).toBeUndefined()
  expect(useLaunchContext.getState().target).toBeUndefined()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('LP-01: another launch settling keeps a waiting drop in its workspace, then releases its target', () => {
  mocks.folderStarting = true
  mocks.loadingWorktrees.add('dropped-workspace')
  const tree = () => (
    <TooltipProvider>
      <NewConversationButton palette />
      <NewConversationButton folder={{ id: 'folder-1', name: 'Folder' }} />
    </TooltipProvider>
  )
  const { rerender } = render(tree())
  const target = { kind: 'workspace' as const, worktreeId: 'dropped-workspace' }
  act(() => {
    useLaunchContext.getState().requestLaunch({ agent: 'codex' }, undefined, target)
  })
  // The folder's own launch settles while the drop still waits for availability.
  mocks.folderStarting = false
  rerender(tree())
  expect(mocks.calls).toEqual([])
  expect(useLaunchContext.getState().target).toBe(target)
  // Even if the shared target is cleared by someone else, the drop keeps its own.
  act(() => useLaunchContext.getState().setTarget(undefined))
  mocks.loadingWorktrees.clear()
  rerender(tree())
  expect(mocks.calls).toEqual([{ worktreeId: 'dropped-workspace', folder: false }])
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
    withLaunchTemplate({ agent: 'codex' }, 'dropped-workspace', true)
  )
})

it('LP-01: a drop releases the shared target it set once its own launch settles', () => {
  const target = { kind: 'workspace' as const, worktreeId: 'dropped-workspace' }
  mocks.holdToolbarStart = true
  const { rerender } = render(toolbarPlus())
  act(() => {
    useLaunchContext.getState().requestLaunch({ agent: 'codex' }, undefined, target)
  })
  expect(mocks.calls).toEqual([{ worktreeId: 'dropped-workspace', folder: false }])
  rerender(toolbarPlus())
  expect(useLaunchContext.getState().target).toBe(target)
  mocks.toolbarStarting = false
  rerender(toolbarPlus())
  expect(useLaunchContext.getState().target).toBeUndefined()
})

it('LP-02: a second drop while one waits is refused; the first still launches', () => {
  mocks.loading = true
  const { rerender } = render(toolbarPlus())
  let accepted: boolean[] = []
  act(() => {
    accepted = [
      useLaunchContext.getState().requestLaunch({ agent: 'claude' }),
      useLaunchContext.getState().requestLaunch({ agent: 'codex' }, 'folder-1')
    ]
  })
  expect(accepted).toEqual([true, false])
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
    'Launch already starting. Drop again once it has opened.'
  )
  mocks.loading = false
  rerender(toolbarPlus())
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
    withLaunchTemplate({ agent: 'claude' }, null, true)
  )
})

it('holds a folder drop target through review and releases it after cancellation', () => {
  const target = { kind: 'workspace' as const, worktreeId: 'dropped-workspace' }
  render(<NewConversationButton folder={{ id: 'folder-1', name: 'Folder' }} />)
  act(() => useLaunchContext.getState().requestLaunch({ agent: 'claude' }, 'folder-1', target))
  expect(useLaunchReview.getState().request?.worktreeId).toBe(target.worktreeId)
  act(() => useLaunchContext.getState().setTarget(undefined))
  expect(mocks.capabilityWorktrees.at(-1)).toBe(target.worktreeId)
  expect(mocks.start).not.toHaveBeenCalled()
  act(() => useLaunchReview.getState().close())
  expect(mocks.start).not.toHaveBeenCalled()
  expect(useLaunchContext.getState().pendingLaunch).toBeUndefined()
})

it('refuses a reviewed launch after its original selected computer changes', () => {
  render(<NewConversationButton folder={{ id: 'folder-1', name: 'Folder' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'New conversation in Folder' }))
  const review = useLaunchReview.getState().request!
  mocks.ownerCurrent = false
  act(() => {
    useLaunchReview.getState().close()
    review.onStart(review.manifest, [])
  })
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledWith(
    'The selected computer changed. Reopen the launcher to start there.'
  )
})
