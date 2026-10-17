// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationCapacityRecovery } from '../../../../shared/conversation-capacity-recovery'
import type { PromptQueue } from '../../../../shared/prompt-queue-types'
import { PromptQueueStrip } from './PromptQueueStrip'

const mocks = vi.hoisted(() => ({
  queue: null as PromptQueue | null,
  activate: vi.fn(),
  sessions: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn()
}))
vi.mock('./use-prompt-queue', () => ({
  usePromptQueue: () => ({
    queue: mocks.queue,
    remove: mocks.remove,
    reorder: mocks.reorder,
    clearDelivered: vi.fn(),
    error: null
  })
}))
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: mocks.activate }))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: mocks.sessions }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const source = { worktreeId: 'workspace', paneKey: 'term:old:pane', kind: 'pty' as const }
const recovery: ConversationCapacityRecovery = {
  id: 'capacity-recovery:version',
  sourceVersion: 'version',
  sourceProcessIncarnation: 'incarnation',
  sourcePtyId: 'pty-1',
  sourceAgent: 'claude',
  sourceProviderSessionId: 'session-1',
  sourceTranscriptPath: '/account/session.jsonl',
  sourceAccountHome: '/accounts/claude-main',
  sourceWorkspacePath: '/workspace',
  sourceFailedAt: 1,
  detectedAt: 2,
  phase: 'delivered',
  target: {
    agent: 'codex',
    accountHome: '/accounts/codex-backup',
    accountChoiceId: 'managed:backup'
  },
  successor: {
    tabId: 'term:replacement',
    leafId: 'next',
    handle: 'handle-2',
    launchToken: 'launch-2',
    operationId: 'operation-2'
  },
  brief: 'The headline was changed. Inspect the saved file before reporting completion.',
  reason: 'The previous account reached its usage limit.',
  attemptAccounts: ['/accounts/claude-main']
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.queue = { source, entries: [], recovery }
  mocks.activate.mockResolvedValue(true)
  mocks.sessions.mockReturnValue([])
})
afterEach(cleanup)

describe('account recovery in the conversation header', () => {
  it('shows the persisted handoff and context without claiming completion or human dependency', () => {
    render(<PromptQueueStrip source={source} />)
    expect(screen.getByText('Context delivered to replacement agent')).toBeTruthy()
    expect(screen.getByText('Claude · claude-main → Codex · codex-backup')).toBeTruthy()
    expect(screen.getByText(recovery.reason!)).toBeTruthy()
    expect(screen.queryByText(/Needs You|Done/)).toBeNull()
    expect(screen.queryByText(recovery.brief)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Saved handoff context' }))
    expect(screen.getByText(recovery.brief)).toBeTruthy()
    expect(screen.getByText('Original history: /account/session.jsonl')).toBeTruthy()
    expect(screen.getByText(/Delivery does not mean the work is complete/)).toBeTruthy()
  })

  it.each(['queued', 'sending', 'failed', 'delivered'] as const)(
    'never presents an internal %s recovery entry as a reorderable human instruction',
    (state) => {
      mocks.queue = {
        source,
        entries: [{ id: 'capacity-recovery:version', text: 'INTERNAL BRIEF', createdAt: 1, state }]
      }
      const { container } = render(<PromptQueueStrip source={source} />)
      expect(container.querySelector('[data-prompt-queue-strip]')).toBeNull()
      expect(screen.queryByText('INTERNAL BRIEF')).toBeNull()
      expect(mocks.remove).not.toHaveBeenCalled()
      expect(mocks.reorder).not.toHaveBeenCalled()
    }
  )

  it('counts and exposes controls only for human prompts in a mixed queue', () => {
    mocks.queue = {
      source,
      recovery,
      entries: [
        { id: 'capacity-recovery:version', text: 'INTERNAL BRIEF', createdAt: 1, state: 'queued' },
        { id: 'human-1', text: 'Only change the headline', createdAt: 2, state: 'queued' }
      ]
    }
    render(<PromptQueueStrip source={source} />)
    expect(screen.getByText('Queued 1')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Remove this queued prompt' })).toHaveLength(1)
    expect(screen.queryByText('INTERNAL BRIEF')).toBeNull()
  })

  it('opens the exact existing successor through normal session activation', () => {
    const successor = {
      worktreeId: 'workspace',
      hostId: 'local',
      tabId: 'term:replacement',
      rowKey: 'replacement'
    }
    mocks.sessions.mockReturnValue([
      { ...successor, worktreeId: 'different-workspace' },
      { ...successor, hostId: 'ssh:remote-host' },
      successor
    ])
    render(<PromptQueueStrip source={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open continuation' }))
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(successor)
  })

  it('reports a held recovery as paused, without sending or asking for a human decision', () => {
    mocks.queue = { source, entries: [], recovery: { ...recovery, phase: 'held' } }
    render(<PromptQueueStrip source={source} />)
    expect(screen.getByText('Account handoff paused')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open continuation' })).toBeNull()
    expect(screen.queryByText(/Needs You|Done/)).toBeNull()
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('shows a capacity wait without inventing a replacement or requiring a person', () => {
    mocks.queue = {
      source,
      entries: [],
      recovery: {
        ...recovery,
        phase: 'waiting-capacity',
        target: undefined,
        successor: undefined,
        reason:
          'No eligible account has capacity. Account capacity will be rechecked automatically.'
      }
    }
    render(<PromptQueueStrip source={source} />)
    expect(screen.getByText('Waiting for account capacity')).toBeTruthy()
    expect(screen.getByText('Claude · claude-main')).toBeTruthy()
    expect(screen.queryByText(/Codex|→|Needs You|Done/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open continuation' })).toBeNull()
    expect(mocks.activate).not.toHaveBeenCalled()
  })
})
