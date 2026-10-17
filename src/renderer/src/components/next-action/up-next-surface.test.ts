import { expect, it, vi } from 'vitest'
import { upNextSurface } from './up-next-surface'
import { createNextStepCard } from '../next-step/next-step-task-create'
import { launchNextStepAgent } from '../next-step/next-step-agent-launch'
import type { UpNextPersonBlock } from '../../../../shared/up-next-types'
import type { NextStepSubject } from '../next-step/next-step-subject'
const source = { kind: 'pty', worktreeId: 'w', paneKey: 'p' }
const session = { worktreeId: 'w', tabId: 't', label: 'Work' }
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: { defaultTuiAgent: 'claude' } }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: () => [session] }))
vi.mock('@/lib/conversation-source-for-session', () => ({
  conversationSourceForSession: () => source
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  findTerminalHandleTarget: () => ({ worktreeId: 'w', tabId: 't' })
}))
vi.mock('../next-step/next-step-task-create', () => ({
  createNextStepCard: vi.fn(),
  nextStepCardTitle: () => 'Card title'
}))
vi.mock('../next-step/next-step-agent-launch', () => ({ launchNextStepAgent: vi.fn() }))

it('uses the existing card creator and reuses its id if a patch needs retrying', async () => {
  vi.mocked(createNextStepCard).mockResolvedValue({ task: { id: 'created', title: 'Card title' } })
  const surface = upNextSurface()
  const block = { id: 'person', receive: { note: 'note' } } as UpNextPersonBlock
  expect(await surface.createCard!(block, source as never)).toBe('created')
  expect(await surface.createCard!(block, source as never)).toBe('created')
  expect(createNextStepCard).toHaveBeenCalledExactlyOnceWith(
    session,
    'Card title',
    'note',
    'best-effort'
  )
})
it.each(['card', 'thread'] as const)(
  'waits for the existing %s launch door to publish its exact tab',
  async (kind) => {
    const subject =
      kind === 'card'
        ? { kind, item: { task_id: 'task', title: 'Card' } }
        : {
            kind,
            viewer: 'sal',
            detail: { thread: { id: 'thread', title: 'Thread', recipient_employee_id: 'sal' } }
          }
    vi.mocked(launchNextStepAgent).mockImplementation((_subject, _agent, _operation, callbacks) => {
      callbacks!.onLaunched!('w', 't')
      return { ok: true, message: 'started' }
    })
    const surface = upNextSurface(subject as NextStepSubject)
    expect(await surface.start!()).toEqual(source)
    expect(await surface.start!()).toEqual(source)
    expect(launchNextStepAgent).toHaveBeenLastCalledWith(
      subject,
      expect.anything(),
      expect.any(String),
      expect.anything()
    )
  }
)
