import { beforeEach, expect, it, vi } from 'vitest'
import { dispatchSessionUpNext } from './dispatch-session-up-next'
import { emptyNextStepDraft } from '../../../../../shared/next-step-draft'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { UP_NEXT_RPC } from '../../../../../shared/up-next-types'

const ports = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), commit: vi.fn() }))
vi.mock('../up-next-client', () => ({ readUpNext: ports.read, writeUpNext: ports.write }))
vi.mock('../up-next-commit', () => ({ commitUpNext: ports.commit }))
vi.mock('../up-next-surface', () => ({ upNextSurface: () => ({}) }))
const session = {
  rowKey: 'row',
  worktreeId: 'folder:work',
  paneKey: 'tab:leaf',
  tabId: 'tab',
  hostId: 'local',
  kind: 'terminal',
  label: 'Work',
  agent: 'claude'
} as SidebarSession
const draft = () => ({
  ...emptyNextStepDraft(),
  placement: 'local' as const,
  end: 'done' as const,
  recipients: [
    {
      kind: 'agent' as const,
      key: 'actor',
      agent: 'claude' as const,
      presetId: null,
      instructions: 'Continue the current work.',
      rounds: 1,
      model: 'claude-model',
      effort: 'high'
    }
  ]
})
beforeEach(() => {
  vi.resetAllMocks()
  ports.read.mockResolvedValue({ conversationId: { kind: 'pty' }, draftCount: 0 })
  ports.write.mockResolvedValue(undefined)
  ports.commit.mockResolvedValue(undefined)
})
it('routes local Runs on through an agent block and atomic composer commit', async () => {
  expect(await dispatchSessionUpNext(session, draft())).toMatchObject({ ok: true })
  expect(ports.write).toHaveBeenCalledWith(
    expect.anything(),
    UP_NEXT_RPC.append,
    {
      draft: {
        kind: 'agent',
        template: 'custom',
        instruction: 'Continue the current work.',
        advanced: { model: 'claude-model', effort: 'high', rounds: 1, endOnSuccess: true }
      }
    },
    expect.any(Function)
  )
  expect(ports.commit).toHaveBeenCalledOnce()
})
it('refuses existing drafts before appending or committing unrelated work', async () => {
  ports.read.mockResolvedValue({ draftCount: 1 })
  expect(await dispatchSessionUpNext(session, draft())).toMatchObject({ ok: false })
  expect(ports.write).not.toHaveBeenCalled()
  expect(ports.commit).not.toHaveBeenCalled()
})
it.each(['ssh:server', 'runtime:peer'] as const)(
  'refuses %s without substituting local execution',
  async (hostId) => {
    expect(await dispatchSessionUpNext({ ...session, hostId }, draft())).toMatchObject({
      ok: false,
      message: expect.stringContaining('legacy_renderer_chain_creation_refused')
    })
    expect(ports.read).not.toHaveBeenCalled()
  }
)
it('preserves a failed commit for composer recovery instead of reporting success', async () => {
  ports.commit.mockRejectedValue(new Error('durable commit failed'))
  await expect(dispatchSessionUpNext(session, draft())).rejects.toThrow('durable commit failed')
  expect(ports.write).toHaveBeenCalledTimes(1)
})
