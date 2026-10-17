// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { upNextSurface } from './up-next-surface'
import { createNextStepCard } from '../next-step/next-step-task-create'
import { scheduleWhenFinished } from '@/lib/session-when-finished'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { UpNextPersonBlock } from '../../../../shared/up-next-types'

const state = vi.hoisted(() => ({ sessions: [] as unknown[] }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/sidebar-sessions', () => ({
  buildPaneSessions: () => state.sessions
}))
vi.mock('../next-step/next-step-task-create', () => ({
  createNextStepCard: vi.fn(async () => ({
    task: { id: 'card-a', title: 'Card' }
  })),
  nextStepCardTitle: () => 'Card'
}))
vi.mock('@/lib/session-when-finished', () => ({
  scheduleWhenFinished: vi.fn(),
  readWhenFinished: vi.fn()
}))
vi.mock('../next-step/next-step-agent-launch', () => ({
  launchNextStepAgent: vi.fn()
}))

const source = { kind: 'pty', worktreeId: 'w', paneKey: 'tab:leaf' } as const
const session = {
  ...source,
  kind: 'terminal',
  tabId: 'tab',
  label: 'Work'
} as SidebarSession
const block = { id: 'person', receive: { note: 'note' } } as UpNextPersonBlock

beforeEach(() => {
  vi.clearAllMocks()
  state.sessions = ['local', 'runtime:host-b', 'runtime:host-a'].map((hostId) => ({
    ...session,
    hostId
  }))
})

it('files and finishes only the selected host when workspace and pane IDs collide', async () => {
  const surface = upNextSurface(undefined, {
    kind: 'environment',
    environmentId: 'host-a'
  })
  await surface.createCard!(block, source)
  await surface.finish!({ action: 'end' }, source)
  expect(createNextStepCard).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'runtime:host-a' }),
    'Card',
    'note',
    'best-effort'
  )
  expect(scheduleWhenFinished).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'runtime:host-a' }),
    { action: 'end' }
  )
})

it('refuses a vanished peer session instead of selecting the matching local pane', async () => {
  state.sessions.pop()
  const surface = upNextSurface(undefined, {
    kind: 'environment',
    environmentId: 'host-a'
  })
  await expect(surface.createCard!(block, source)).rejects.toThrow()
  await expect(surface.finish!({ action: 'end' }, source)).rejects.toThrow()
  expect(createNextStepCard).not.toHaveBeenCalled()
  expect(scheduleWhenFinished).not.toHaveBeenCalled()
})

it('does not let local Next controls take ownership of a paired pane', async () => {
  state.sessions.shift()
  await expect(upNextSurface().createCard!(block, source)).rejects.toThrow()
  expect(createNextStepCard).not.toHaveBeenCalled()
})
