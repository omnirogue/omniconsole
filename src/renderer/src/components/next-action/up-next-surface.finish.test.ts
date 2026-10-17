// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { upNextSurface } from './up-next-surface'
import { applyWhenFinished } from '@/lib/session-when-finished'
import { useSessionFolders } from '@/store/session-folders'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const session = {
  worktreeId: 'wt',
  tabId: 'tab-1',
  paneKey: 'tab-1:leaf-1',
  rowKey: 'row',
  label: 'Work',
  hostId: 'local'
} as SidebarSession
const source = { kind: 'pty', worktreeId: 'wt', paneKey: 'tab-1:leaf-1' } as const
const mocks = vi.hoisted(() => ({
  close: vi.fn(async (_tab: string, _options?: unknown) => true),
  save: vi.fn(() => true),
  busy: false,
  read: vi.fn(),
  setFinished: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }), subscribe: () => () => {} }
}))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: () => [session] }))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  findTerminalHandleTarget: () => null
}))
vi.mock('../next-step/next-step-task-create', () => ({
  createNextStepCard: vi.fn(),
  nextStepCardTitle: () => 'Card'
}))
vi.mock('../next-step/next-step-agent-launch', () => ({ launchNextStepAgent: vi.fn() }))
vi.mock('@/lib/close-session-tab', () => ({
  closeSessionTab: (...args: unknown[]) => mocks.close(args[0] as string, args[1]),
  sessionTabHasUnfinishedAgent: () => mocks.busy
}))
vi.mock('./up-next-client', () => ({ readUpNext: (...args: unknown[]) => mocks.read(...args) }))
vi.mock('./up-next-connection', () => ({ upNextConnection: () => ({ assertCurrent: () => {} }) }))
vi.mock('@/store/wait-later-store', () => ({
  useWaitLater: { getState: () => ({ setFinished: mocks.setFinished }) }
}))
const preference = () => useSessionFolders.getState().metadata.finishActions!.row!
const apply = () => applyWhenFinished(session, preference(), mocks.save)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.busy = false
  mocks.read.mockResolvedValue({ finishReady: false })
  useSessionFolders.setState({ loaded: true, error: null, metadata: emptySessionFolderMetadata() })
})

it('accepts Close while working, then closes once the host confirms all work finished', async () => {
  mocks.busy = true
  await upNextSurface().finish!({ action: 'end' }, source)
  expect(preference()).toMatchObject({ action: 'end', afterCompletion: true, applied: false })
  await apply()
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.busy = false
  await apply()
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.read.mockResolvedValue({ finishReady: true })
  await apply()
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith('tab-1', { rejectPinned: true })
  await apply()
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('persists Save through reload and files the chosen folder only after completion', async () => {
  await upNextSurface().finish!({ action: 'save', folderId: 'acceptance' }, source)
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: false })
  useSessionFolders.getState().load()
  expect(preference()).toMatchObject({ action: 'save', folderId: 'acceptance' })
  await apply()
  expect(mocks.save).not.toHaveBeenCalled()
  mocks.read.mockResolvedValue({ finishReady: true })
  await apply()
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(session, 'acceptance')
  expect(mocks.close).not.toHaveBeenCalled()
})

it('clearing a choice during an in-flight readiness read prevents closing', async () => {
  upNextSurface().scheduleFinish!({ action: 'end' }, source)
  let resolve!: (view: unknown) => void
  mocks.read.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const pending = apply()
  upNextSurface().scheduleFinish!(null, source)
  resolve({ finishReady: true })
  await pending
  expect(mocks.close).not.toHaveBeenCalled()
  expect(useSessionFolders.getState().metadata.finishActions?.row).toBeUndefined()
})

it('leaves the session open when an older host provides no completion confirmation', async () => {
  upNextSurface().scheduleFinish!({ action: 'end' }, source)
  mocks.read.mockResolvedValue({})
  await apply()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(preference().applied).toBe(false)
})
