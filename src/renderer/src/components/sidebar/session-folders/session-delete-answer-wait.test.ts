import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { MirroredSidebarConversation } from '@/lib/mirrored-conversation-row-types'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))

const { findSessionAnswerWait, sessionAnswerWaitConfirmation } =
  await import('./session-delete-answer-wait')

function row(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: null,
    worktreeId: 'repo::/w',
    hostId: 'local',
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: 'Parser fix',
    workspaceLabel: 'Work',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

const plain = row({ paneKey: 'tab-1:1' })
const resumed = row({
  label: 'Release plan',
  providerSession: { key: 'claude', id: 'conv-2' } as unknown as SidebarSession['providerSession']
})

describe('the answer-wait warning before a person deletes sessions', () => {
  beforeEach(() => {
    rpc.call.mockReset()
  })

  it('asks main about each session by pane and conversation, and names the decision first', async () => {
    rpc.call.mockResolvedValue({
      waits: [
        [{ kind: 'question', key: 'q1' }],
        [{ kind: 'review', slug: 'plan', title: 'plan.md' }]
      ]
    })
    const found = await findSessionAnswerWait([plain, resumed])
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'sessionDecisions.answerWaits',
      {
        sessions: [
          { paneKey: 'tab-1:1', worktreeId: 'repo::/w', providerSessionId: null },
          { paneKey: null, worktreeId: 'repo::/w', providerSessionId: 'conv-2' }
        ]
      },
      { timeoutMs: 5_000 }
    )
    expect(found).toEqual({
      session: resumed,
      wait: { kind: 'review', slug: 'plan', title: 'plan.md' }
    })
    expect(sessionAnswerWaitConfirmation(found!)).toEqual({
      title: 'Still waiting on you: Release plan',
      description: 'A decision is still waiting on this session: plan.md. Delete it anyway?',
      confirmLabel: 'Delete anyway',
      confirmVariant: 'destructive'
    })
  })

  it('words an open Question on its own', async () => {
    rpc.call.mockResolvedValue({ waits: [[{ kind: 'question', key: 'q1' }]] })
    const found = await findSessionAnswerWait([plain])
    expect(sessionAnswerWaitConfirmation(found!).description).toBe(
      'A Question on this session is still waiting for your answer. Delete it anyway?'
    )
  })

  it('asks nothing for rows with no identity or a paired owner’s conversation', async () => {
    const mirrored = row({
      paneKey: 'tab-2:1',
      mirroredConversation: {} as MirroredSidebarConversation
    })
    expect(await findSessionAnswerWait([row({}), mirrored])).toBeNull()
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('lets the delete go unwarned when nothing waits or main cannot answer', async () => {
    rpc.call.mockResolvedValue({ waits: [[]] })
    expect(await findSessionAnswerWait([plain])).toBeNull()
    rpc.call.mockRejectedValue(new Error('Unknown method'))
    expect(await findSessionAnswerWait([plain])).toBeNull()
  })

  it('splits a large batch at the RPC limit', async () => {
    rpc.call.mockImplementation(async (_target, _method, params: { sessions: unknown[] }) => ({
      waits: params.sessions.map(() => [])
    }))
    const many = Array.from({ length: 1_001 }, (_, index) => row({ paneKey: `tab-${index}:1` }))
    expect(await findSessionAnswerWait(many)).toBeNull()
    expect(rpc.call).toHaveBeenCalledTimes(2)
  })
})
