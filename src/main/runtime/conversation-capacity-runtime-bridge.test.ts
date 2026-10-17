import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { ConversationCapacityRecovery } from '../../shared/conversation-capacity-recovery'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PromptQueues } from '../../shared/prompt-queue-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { OrcaRuntimeService } from './omni-runtime'
import { readCompleteSessionTranscript } from '../transcripts/complete-session-transcript-reader'
import { lastInputAtByPty } from '../ipc/pty/delivery/visibility-state'
import type { IPtyProvider } from '../providers/types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  lastInputAtByPty.clear()
})

const worktreeId = 'recovery-worktree'
const tabId = 'recovery-tab'
const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey(tabId, leafId)
const ptyId = 'recovery-pty'
const source: ConversationSource = { kind: 'pty', worktreeId, paneKey }
const sourceKey = conversationSourceRowKey(source)

function harness(
  options: {
    launchedAsShellCommand?: boolean
    codexTranscriptPath?: string
    claudeTranscriptPath?: string
  } = {}
) {
  const agent = options.codexTranscriptPath ? ('codex' as const) : ('claude' as const)
  const row: AgentStatusIpcPayload = {
    state: 'done',
    prompt: 'Finish the requested edit and check the saved file.',
    failed: true,
    failureReason: 'You have hit your limit',
    paneKey,
    tabId,
    worktreeId,
    connectionId: null,
    agentType: 'claude',
    model: 'fable',
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    launchToken: 'launch-token',
    providerSession: {
      key: 'session_id',
      id: 'provider-session',
      transcriptPath: '/accounts/one/projects/repo/session.jsonl'
    }
  }
  if (options.codexTranscriptPath) {
    // Codex reports no failed Stop: its last hook is the prompt that started the turn.
    Object.assign(row, {
      state: 'working',
      failed: undefined,
      failureReason: undefined,
      agentType: 'codex',
      model: 'gpt-5.5',
      stateStartedAt: Date.now() - 60_000,
      providerSession: {
        key: 'session_id',
        id: 'provider-session',
        transcriptPath: options.codexTranscriptPath
      }
    })
  }
  if (options.claudeTranscriptPath) {
    Object.assign(row, {
      state: 'working',
      failed: undefined,
      failureReason: undefined,
      stateStartedAt: Date.now() - 60_000,
      providerSession: {
        key: 'session_id',
        id: 'provider-session',
        transcriptPath: options.claudeTranscriptPath
      }
    })
  }
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => [row],
    getAgentProviderSessionSnapshot: () => [row]
  })
  vi.spyOn(runtime, 'getAgentStatusOrchestrationContextForPaneKey').mockReturnValue(undefined)
  const state = { promptQueues: {} as PromptQueues } as PersistedState
  const persistence = new PromptQueuePersistence(
    { state, flushOrThrow: vi.fn() },
    {} as WriteSchedulingOperations
  )
  const store = {
    getWorktreeMeta: vi.fn(() => undefined),
    getFolderWorkspaces: () => [],
    listAutomationRuns: () => [],
    listSessionChains: () => [],
    listPromptQueues: () => persistence.listPromptQueues(),
    readPromptQueue: (key: string) => persistence.readPromptQueue(key),
    saveConversationCapacityRecoveryAndFlush: (
      address: ConversationSource,
      recovery: ConversationCapacityRecovery | null
    ) => persistence.saveConversationCapacityRecoveryAndFlush(address, recovery),
    removePromptQueueEntry: (key: string, id: string) =>
      persistence.removePromptQueueEntry(key, id),
    enqueuePromptQueueEntry: (address: ConversationSource, entry: unknown) =>
      persistence.enqueuePromptQueueEntry(address, entry)
  }
  const internal = runtime as unknown as {
    store: unknown
    accountServices: unknown
    getWorkspaceSessionForWorktree: () => null
    ptysById: Map<
      string,
      {
        incarnationId: string | null
        connected: boolean
        launchConfig: { agentArgs: string; agentEnv: Record<string, string> } | null
        agentSessionOwners: unknown[]
      }
    >
  }
  internal.store = store
  vi.spyOn(internal, 'getWorkspaceSessionForWorktree').mockReturnValue(null)
  runtime.registerPty(ptyId, worktreeId, null, {
    tabId,
    leafId,
    incarnationId: 'source-incarnation',
    ...(options.launchedAsShellCommand
      ? {}
      : { agentLaunchAuthority: { launchToken: 'launch-token', launchAgent: agent } })
  })
  const stop = vi.fn(async () => true)
  const releaseRendererStop = vi.fn()
  const markReversibleStops = vi.fn(() => releaseRendererStop)
  const listProcesses = vi.fn(async () => [
    { id: ptyId, incarnationId: 'source-incarnation', cwd: '/repo', title: 'Claude' }
  ])
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'claude',
    listProcesses,
    stopAndWait: stop,
    markReversibleStops
  })
  const recovery = (): ConversationCapacityRecovery => {
    const receipt: ConversationCapacityRecovery = {
      id: 'capacity-recovery:one',
      sourceVersion: runtime.listConversationCapacityFailures()[0]!.version,
      sourceProcessIncarnation: `${ptyId}:source-incarnation`,
      sourcePtyId: ptyId,
      sourceAgent: 'claude',
      sourceProviderSessionId: 'provider-session',
      sourceTranscriptPath: row.providerSession!.transcriptPath!,
      sourceAccountHome: '/accounts/one',
      sourceFailedAt: row.stateStartedAt,
      detectedAt: Date.now(),
      phase: 'prepared',
      target: { agent: 'codex', accountHome: '/accounts/two', accountChoiceId: 'managed:two' },
      successor: {
        tabId: 'next-tab',
        leafId: 'next-leaf',
        handle: 'next-handle',
        launchToken: 'next-token',
        operationId: 'next-operation'
      },
      brief: 'Continue the original request using its saved history.',
      attemptAccounts: []
    }
    persistence.saveConversationCapacityRecoveryAndFlush(source, receipt)
    return receipt
  }
  return {
    runtime,
    row,
    internal,
    store,
    state,
    persistence,
    stop,
    listProcesses,
    recovery,
    markReversibleStops,
    releaseRendererStop
  }
}

function codexRollout(error: { message: string; codex_error_info: string }, failedAt: number) {
  const home = mkdtempSync(join(tmpdir(), 'codex-account-'))
  const dir = join(home, 'sessions', '2026', '10', '01')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'rollout-provider-session.jsonl')
  const at = (time: number) => new Date(time).toISOString()
  writeFileSync(
    path,
    [
      {
        timestamp: at(failedAt - 5_000),
        type: 'event_msg',
        payload: { type: 'task_started' }
      },
      {
        timestamp: at(failedAt - 4_000),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ text: 'Finish the edit.' }]
        }
      },
      {
        timestamp: at(failedAt),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: null,
          error
        }
      }
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join('')
  )
  return {
    home,
    path,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  }
}

const CODEX_USAGE_WALL = {
  message:
    'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:04 PM.',
  codex_error_info: 'usage_limit_exceeded'
}

describe('ordinary conversation capacity runtime bridge', () => {
  it('admits a quota-paused Claude child while the parent is working and preserves stop fences', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-workflow-account-'))
    const project = join(home, 'projects', 'repo')
    const children = join(project, 'provider-session', 'subagents')
    const workflow = join(children, 'workflows', 'wf_test')
    mkdirSync(workflow, { recursive: true })
    const transcriptPath = join(project, 'provider-session.jsonl')
    const childPath = join(children, 'agent-ad4e76b90a9128b2b.jsonl')
    const jsonl = (row: object) => `${JSON.stringify(row)}\n`
    const failedAt = Date.now() - 1_000
    writeFileSync(
      transcriptPath,
      jsonl({
        type: 'user',
        sessionId: 'provider-session',
        timestamp: new Date(failedAt - 1_000).toISOString(),
        message: { content: 'Finish setup.' }
      })
    )
    writeFileSync(
      join(workflow, 'journal.jsonl'),
      jsonl({ type: 'started', key: 'verify', agentId: 'ad4e76b90a9128b2b' })
    )
    writeFileSync(
      childPath,
      jsonl({
        type: 'assistant',
        sessionId: 'provider-session',
        agentId: 'ad4e76b90a9128b2b',
        isSidechain: true,
        isApiErrorMessage: true,
        error: 'rate_limit',
        timestamp: new Date(failedAt).toISOString(),
        message: { content: [{ type: 'text', text: "You've hit your weekly limit" }] }
      })
    )
    try {
      const history = await readCompleteSessionTranscript({
        kind: 'provider',
        agent: 'claude',
        sessionId: 'provider-session',
        transcriptPath: childPath,
        expectedConnectionId: null
      })
      expect(history.length).toBeGreaterThan(0)
      const h = harness({ claudeTranscriptPath: transcriptPath })
      expect(h.runtime.listConversationCapacityFailures()).toMatchObject([
        { agent: 'claude', failedAt, accountHome: home, childTranscriptPath: childPath }
      ])
      const receipt = h.recovery()
      expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(true)
      expect(h.stop).toHaveBeenCalledTimes(1)
      // A question or newer input must win, even with an admitted receipt.
      h.row.interactivePrompt = '{"questions":[{"question":"Continue?"}]}'
      expect(h.runtime.listConversationCapacityFailures()).toEqual([])
      delete h.row.interactivePrompt
      lastInputAtByPty.set(ptyId, failedAt - performance.timeOrigin + 1)
      expect(h.runtime.listConversationCapacityFailures()).toEqual([])
      lastInputAtByPty.clear()
      h.internal.ptysById.get(ptyId)!.agentSessionOwners = ['owner']
      expect(h.runtime.listConversationCapacityFailures()).toEqual([])
      h.internal.ptysById.get(ptyId)!.agentSessionOwners = []
      appendFileSync(childPath, jsonl({ type: 'assistant', message: { content: 'Resumed.' } }))
      expect(h.runtime.listConversationCapacityFailures()).toEqual([])
      expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(false)
      expect(h.stop).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('uses native hook identity, exact transcript and account home without creating an Outcome', () => {
    const h = harness()
    expect(h.runtime.listConversationCapacityFailures()).toMatchObject([
      {
        source,
        ptyId,
        processIncarnation: `${ptyId}:source-incarnation`,
        agent: 'claude',
        accountHome: '/accounts/one',
        transcriptPath: h.row.providerSession!.transcriptPath
      }
    ])
    expect(h.state.promptQueues).toEqual({})
    h.internal.ptysById.get(ptyId)!.launchConfig = {
      agentArgs: '',
      agentEnv: { CLAUDE_CONFIG_DIR: '/accounts/different' }
    }
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
  })

  it('recovers a plan-limit wall in a pane omni-launch-best started as a shell command', () => {
    const h = harness({ launchedAsShellCommand: true })
    h.row.failureReason = "You've hit your weekly limit · resets 9am (America/New_York)"
    expect(h.runtime.listConversationCapacityFailures()).toMatchObject([
      { source, ptyId, agent: 'claude', accountHome: '/accounts/one' }
    ])
    h.row.agentType = 'gemini' as 'claude'
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
  })

  it('does not treat a transient rate limit, missing incarnation or another controller as recoverable', () => {
    const h = harness()
    h.row.failureReason = 'rate_limit_error'
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
    h.row.failureReason = 'You have hit your limit'
    h.internal.ptysById.get(ptyId)!.incarnationId = null
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
    h.internal.ptysById.get(ptyId)!.incarnationId = 'source-incarnation'
    h.internal.ptysById.get(ptyId)!.agentSessionOwners = [{}]
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
  })

  it('corroborates a generic rate limit only against fresh capacity for the actual model', () => {
    const h = harness()
    h.row.failureReason = 'rate_limit_error'
    const account = {
      state: 'ready',
      readingAt: Date.now(),
      launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/one' },
      fiveHour: { remainingPercent: 50 },
      weekly: { remainingPercent: 50 },
      fableWeekly: { remainingPercent: 0 }
    }
    h.internal.accountServices = {
      rateLimits: { getState: () => ({ accountCapacity: { claude: [account] } }) }
    }
    expect(h.runtime.listConversationCapacityFailures()).toMatchObject([{ model: 'fable' }])
    h.row.model = 'sonnet'
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
    h.row.model = 'fable'
    account.readingAt = Date.now() - 300_001
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
  })

  it('retains an already admitted generic failure when its account capacity resets', async () => {
    const h = harness()
    h.row.failureReason = 'rate_limit_error'
    const account = {
      state: 'limited',
      readingAt: Date.now(),
      launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/one' }
    }
    h.internal.accountServices = {
      rateLimits: { getState: () => ({ accountCapacity: { claude: [account] } }) }
    }
    const receipt = h.recovery()
    h.persistence.saveConversationCapacityRecoveryAndFlush(source, receipt)
    account.state = 'ready'
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(true)
    expect(h.stop).toHaveBeenCalledOnce()
  })

  it('stops only the exact failed process and requests an internal stop preserving history', async () => {
    const h = harness()
    const receipt = h.recovery()
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(true)
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(ptyId, {
      keepHistory: true,
      reason: 'capacity-recovery',
      beforeStop: expect.any(Function)
    })
    expect(h.runtime.isPtyStopRequested(ptyId)).toBe(false)
    expect(h.markReversibleStops).toHaveBeenCalledExactlyOnceWith([ptyId])
    expect(h.releaseRendererStop).toHaveBeenCalledOnce()
  })

  it('releases renderer preservation only after the capacity stop settles', async () => {
    const h = harness()
    const receipt = h.recovery()
    h.stop.mockImplementationOnce(async () => {
      expect(h.markReversibleStops).toHaveBeenCalledExactlyOnceWith([ptyId])
      expect(h.releaseRendererStop).not.toHaveBeenCalled()
      throw new Error('stop unavailable')
    })
    await expect(h.runtime.stopConversationCapacitySource(source, receipt)).rejects.toThrow(
      'stop unavailable'
    )
    expect(h.releaseRendererStop).toHaveBeenCalledOnce()
  })

  it('records user input before a recovery receipt exists so preparation cannot take over stale work', () => {
    const h = harness()
    h.row.stateStartedAt = Date.now() - 1_000
    expect(h.runtime.listConversationCapacityFailures()).toHaveLength(1)
    expect(h.runtime.readPromptQueue(sourceKey)).toBeNull()
    h.runtime.cancelConversationCapacityRecoveryForPty(ptyId, 'New terminal input.')
    expect(h.runtime.listConversationCapacityFailures()).toEqual([])
    expect(h.runtime.readPromptQueue(sourceKey)).toBeNull()
  })

  it('rechecks persisted cancellation immediately before stopping after the inventory await', async () => {
    const h = harness()
    const receipt = h.recovery()
    h.listProcesses.mockImplementationOnce(async () => {
      h.persistence.saveConversationCapacityRecoveryAndFlush(source, {
        ...receipt,
        phase: 'cancelled',
        reason: 'New terminal input.'
      })
      return [{ id: ptyId, incarnationId: 'source-incarnation', cwd: '/repo', title: 'Claude' }]
    })
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(false)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('does not stop a session the person resumed while the inventory was in flight', async () => {
    const h = harness()
    const receipt = h.recovery()
    h.listProcesses.mockImplementationOnce(async () => {
      h.runtime.cancelConversationCapacityRecoveryForPty(ptyId, 'New terminal input.')
      return [{ id: ptyId, incarnationId: 'source-incarnation', cwd: '/repo', title: 'Claude' }]
    })
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(false)
    expect(h.runtime.readPromptQueue(sourceKey)?.recovery?.phase).toBe('cancelled')
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('cancels for successor input before creation has returned its source address', () => {
    const h = harness()
    const receipt = h.recovery()
    receipt.phase = 'stopped'
    receipt.successor!.tabId = 'successor-tab'
    receipt.successor!.leafId = '22222222-2222-4222-8222-222222222222'
    h.persistence.saveConversationCapacityRecoveryAndFlush(source, receipt)
    h.runtime.registerPty('successor-pty', worktreeId, null, {
      tabId: receipt.successor!.tabId,
      leafId: receipt.successor!.leafId,
      incarnationId: 'successor-incarnation',
      agentLaunchAuthority: { launchToken: 'successor-token', launchAgent: 'codex' }
    })
    h.runtime.cancelConversationCapacityRecoveryForPty('successor-pty', 'New terminal input.')
    expect(h.runtime.readPromptQueue(sourceKey)?.recovery).toMatchObject({
      phase: 'cancelled',
      reason: 'New terminal input.'
    })
  })

  it('requires explicit daemon create idempotency and defers a provider swap during its probe', async () => {
    const h = harness()
    const provider = {} as IPtyProvider
    const current = vi.spyOn(h.runtime, 'getLocalProvider').mockReturnValue(provider)
    expect(await h.runtime.supportsConversationCapacityRecovery()).toBe(false)
    provider.supportsAgentSessionCreateOperations = vi.fn(async () => true)
    expect(await h.runtime.supportsConversationCapacityRecovery()).toBe(true)
    Object.assign(provider, { routesFreshSpawnsToLocalProvider: true })
    expect(await h.runtime.supportsConversationCapacityRecovery()).toBe(false)
    Reflect.deleteProperty(provider, 'routesFreshSpawnsToLocalProvider')
    provider.supportsAgentSessionCreateOperations = vi.fn(async () => {
      current.mockReturnValue({} as IPtyProvider)
      return true
    })
    expect(await h.runtime.supportsConversationCapacityRecovery()).toBeNull()
  })

  it('defers an alive source until reattachment, then accepts its retained failed turn without a new hook', async () => {
    const h = harness()
    h.row.receivedAt -= 3_600_000
    h.row.stateStartedAt = h.row.receivedAt
    const receipt = h.recovery()
    h.persistence.saveConversationCapacityRecoveryAndFlush(source, receipt)
    h.internal.ptysById.delete(ptyId)
    Reflect.deleteProperty(h.row, 'launchToken')

    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBeNull()
    expect(h.stop).not.toHaveBeenCalled()

    h.runtime.registerPty(ptyId, worktreeId, null, {
      tabId,
      leafId,
      incarnationId: 'source-incarnation',
      providerReattachLaunchIdentity: {
        incarnationId: 'source-incarnation',
        launchAgent: 'claude'
      }
    })
    expect(h.runtime.listConversationCapacityFailures()[0]?.version).toBe(receipt.sourceVersion)
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(true)
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(ptyId, {
      keepHistory: true,
      reason: 'capacity-recovery',
      beforeStop: expect.any(Function)
    })
  })

  it('accepts a proven prior stop on replay, but not a new process occupying the same pane', async () => {
    const h = harness()
    const receipt = h.recovery()
    h.listProcesses.mockResolvedValue([])
    h.internal.ptysById.get(ptyId)!.connected = false
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(true)
    h.runtime.registerPty('replacement-pty', worktreeId, null, {
      tabId,
      leafId,
      incarnationId: 'new-incarnation',
      agentLaunchAuthority: { launchToken: 'new-token', launchAgent: 'codex' }
    })
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(false)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('rechecks Stop after the authoritative inventory await', async () => {
    const h = harness()
    const receipt = h.recovery()
    h.listProcesses.mockImplementation(async () => {
      h.runtime.markPtyStopRequested(ptyId)
      return [{ id: ptyId, incarnationId: 'source-incarnation', cwd: '/repo', title: 'Claude' }]
    })
    expect(await h.runtime.stopConversationCapacitySource(source, receipt)).toBe(false)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('cancels a persisted waiting-capacity record after restart without a successor', () => {
    const original = harness()
    const receipt = original.recovery()
    delete receipt.target
    delete receipt.successor
    receipt.phase = 'waiting-capacity'
    original.persistence.saveConversationCapacityRecoveryAndFlush(source, receipt)
    const saved = JSON.parse(JSON.stringify(original.state.promptQueues)) as PromptQueues
    const restarted = harness()
    restarted.state.promptQueues = saved
    restarted.runtime.markPtyStopRequested(ptyId)
    expect(restarted.runtime.readPromptQueue(sourceKey)?.recovery).toMatchObject({
      id: receipt.id,
      phase: 'cancelled',
      reason: 'Stopped by the user.'
    })
    expect(restarted.stop).not.toHaveBeenCalled()
  })

  it.each(['stop', 'queue'] as const)(
    '%s cancels persisted recovery and removes its queued successor prompt',
    (action) => {
      const h = harness()
      const successor: ConversationSource = {
        kind: 'pty',
        worktreeId,
        paneKey: 'next-tab:next-leaf'
      }
      const receipt = { ...h.recovery(), phase: 'created' as const }
      receipt.successor!.source = successor
      h.persistence.saveConversationCapacityRecoveryAndFlush(source, receipt)
      h.persistence.enqueuePromptQueueEntry(successor, {
        id: receipt.id,
        text: receipt.brief,
        createdAt: Date.now(),
        state: 'queued'
      })
      if (action === 'stop') {
        h.runtime.markPtyStopRequested(ptyId)
      } else {
        h.runtime.enqueuePromptQueueEntry(source, {
          id: 'human',
          text: 'Do this instead.',
          createdAt: Date.now(),
          state: 'queued'
        })
      }
      expect(h.runtime.readPromptQueue(sourceKey)?.recovery?.phase).toBe('cancelled')
      expect(h.runtime.readPromptQueue(conversationSourceRowKey(successor))?.entries ?? []).toEqual(
        []
      )
    }
  )
  it('recovers a Codex turn that ended on its usage wall although Codex fired no failed Stop', () => {
    const failedAt = Date.now() - 1_000
    const rollout = codexRollout(CODEX_USAGE_WALL, failedAt)
    try {
      const h = harness({ codexTranscriptPath: rollout.path })
      expect(h.runtime.listConversationCapacityFailures()).toMatchObject([
        {
          source,
          ptyId,
          agent: 'codex',
          accountHome: rollout.home,
          transcriptPath: rollout.path,
          failedAt,
          failureReason: CODEX_USAGE_WALL.message,
          model: 'gpt-5.5'
        }
      ])
      // Typing into the stopped composer is newer work than the failed turn.
      lastInputAtByPty.set(ptyId, failedAt - performance.timeOrigin + 1)
      expect(h.runtime.listConversationCapacityFailures()).toEqual([])
      lastInputAtByPty.clear()
      appendFileSync(
        rollout.path,
        `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`
      )
      expect(h.runtime.listConversationCapacityFailures()).toEqual([])
    } finally {
      rollout.cleanup()
    }
  })

  it('does not hand off a Codex turn that ended on a transient rate limit', () => {
    const rollout = codexRollout(
      {
        message: 'Rate limit reached for requests.',
        codex_error_info: 'rate_limit_exceeded'
      },
      Date.now() - 1_000
    )
    try {
      expect(
        harness({
          codexTranscriptPath: rollout.path
        }).runtime.listConversationCapacityFailures()
      ).toEqual([])
    } finally {
      rollout.cleanup()
    }
  })

  it('ignores a Codex usage wall from before the pane last reported newer activity', () => {
    const rollout = codexRollout(CODEX_USAGE_WALL, Date.now() - 120_000)
    try {
      expect(
        harness({
          codexTranscriptPath: rollout.path
        }).runtime.listConversationCapacityFailures()
      ).toEqual([])
    } finally {
      rollout.cleanup()
    }
  })
})
