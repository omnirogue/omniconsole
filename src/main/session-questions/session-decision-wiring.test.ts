import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { getSessionDecisionStore, startSessionDecisions } from './session-decision-wiring'

const hooks = vi.hoisted(() => ({
  getStatusSnapshot: vi.fn((): AgentStatusIpcPayload[] => []),
  getStatusSnapshotForPane: vi.fn((): AgentStatusIpcPayload[] => []),
  getToolUseIdForPane: vi.fn(() => 'toolu_1'),
  subscribeEnrichedStatus: vi.fn((_listener: (event: AgentHookEventPayload) => void) => vi.fn()),
  subscribePaneStatusClear: vi.fn(() => vi.fn()),
  subscribeStatusDrop: vi.fn(() => vi.fn())
}))

vi.mock('../agent-hooks/server', () => ({ agentHookServer: hooks }))
vi.mock('./session-decision-jev', () => ({ createSessionDecisionScorer: () => vi.fn() }))

const ASK = JSON.stringify({
  questions: [{ question: 'Ship now?', options: [{ label: 'Yes' }, { label: 'No' }] }]
})

function status(patch: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'tab-1:3f1c7a52-8f58-4b3b-9d8a-2d8a6f3a9b10',
    connectionId: null,
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: 'claude-1' },
    state: 'waiting',
    prompt: '',
    agentType: 'claude',
    toolName: 'AskUserQuestion',
    interactivePrompt: ASK,
    receivedAt: 1_000_000,
    stateStartedAt: 1_000_000,
    ...patch
  }
}

describe('session decision startup evidence', () => {
  let directory: string
  let stop: (() => Promise<void>) | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'session-decisions-wiring-'))
    vi.clearAllMocks()
    hooks.getStatusSnapshot.mockReturnValue([])
  })

  afterEach(async () => {
    await stop?.()
    rmSync(directory, { recursive: true, force: true })
  })

  it('does not recreate a dismissed question from the restored startup status', async () => {
    hooks.getStatusSnapshot.mockReturnValue([status()])
    stop = startSessionDecisions({ userDataPath: directory })
    const store = getSessionDecisionStore()!
    expect(store.list()).toHaveLength(1)
    expect(store.remove(store.list()[0]!.key)).toBe(true)
    await stop()

    hooks.getStatusSnapshot.mockReturnValue([status({ restoredUnconfirmed: true })])
    stop = startSessionDecisions({ userDataPath: directory })
    expect(getSessionDecisionStore()!.list()).toEqual([])

    const fresh = status()
    hooks.subscribeEnrichedStatus.mock.calls.at(-1)![0]({
      paneKey: fresh.paneKey,
      connectionId: null,
      providerSession: fresh.providerSession,
      toolUseId: 'toolu_2',
      hookEventName: 'PreToolUse',
      payload: fresh
    })
    expect(
      getSessionDecisionStore()!
        .list()
        .map((row) => row.toolUseId)
    ).toEqual(['toolu_2'])
  })

  it('preserves a durable unanswered question without rewriting it from restored evidence', async () => {
    hooks.getStatusSnapshot.mockReturnValue([status()])
    stop = startSessionDecisions({ userDataPath: directory })
    const pending = getSessionDecisionStore()!.list()[0]!
    await stop()

    hooks.getStatusSnapshot.mockReturnValue([
      status({ restoredUnconfirmed: true, lastAssistantMessage: 'Older cached context.' })
    ])
    stop = startSessionDecisions({ userDataPath: directory })
    expect(getSessionDecisionStore()!.list()).toEqual([pending])
  })
})
