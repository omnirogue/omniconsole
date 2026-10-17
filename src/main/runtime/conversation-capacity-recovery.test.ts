import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))
vi.mock('../transcripts/complete-session-transcript-reader', () => ({
  readCompleteSessionTranscript: vi.fn(async () => [])
}))
vi.mock('./capacity-recovery-brief', () => ({
  buildCapacityRecoveryBrief: vi.fn(() => 'Continue the original request; check the saved edit.'),
  buildCapacityRecoveryTranscript: vi.fn(() => Buffer.from('Saved request and completed edit.'))
}))
vi.mock('./conversation-capacity-source-model', () => ({
  resolveCapacityRecoverySourceModel: vi.fn(
    async (candidate: { model?: string }) => candidate.model
  )
}))
vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { writeFile } from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import type { PersistedState } from '../../shared/persisted-state-types'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import {
  normalizePromptQueues,
  type ConversationCapacityRecovery,
  type PromptQueues
} from '../../shared/prompt-queue-types'
import type { AccountCapacityRow } from '../../shared/provider-account-capacity'
import type { SessionChain } from '../../shared/session-chain-types'
import { readCompleteSessionTranscript } from '../transcripts/complete-session-transcript-reader'
import { buildCapacityRecoveryBrief } from './capacity-recovery-brief'
import {
  advanceConversationCapacityRecovery,
  capacityRecoveryAccountKey,
  selectCapacityRecoveryAccount,
  type CapacityRecoveryCandidate
} from './conversation-capacity-recovery'
import { drainPromptQueues } from './prompt-queue-drain'
import { assignCapacityRecoveryTarget } from './conversation-capacity-account-selection'
import type { OrcaRuntimeService } from './omni-runtime'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'

const source: ConversationSource = { worktreeId: 'workspace', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const sourceKey = conversationSourceRowKey(source)

function account(
  provider: 'claude' | 'codex',
  name: string,
  override: Partial<AccountCapacityRow> = {}
): AccountCapacityRow {
  return {
    provider,
    accountId: name,
    choiceId: `managed:${name}`,
    email: `${name}@example.test`,
    detail: null,
    isDefault: false,
    isSystem: false,
    fiveHour: { remainingPercent: 50, resetsAt: Date.now() + 10_000, windowMinutes: 300 },
    weekly: null,
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: Date.now(),
    readingPausedUntil: null,
    sourceLabel: `/accounts/${name}`,
    launchEnv: {
      [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: `/accounts/${name}`
    },
    ...override
  }
}

function failure(): CapacityRecoveryCandidate {
  return {
    source,
    handle: 'source-handle',
    ptyId: 'source-pty',
    processIncarnation: 'source-incarnation',
    agent: 'claude',
    providerSessionId: 'source-session',
    transcriptPath: '/accounts/source/transcript.jsonl',
    accountHome: '/accounts/source',
    failedAt: Date.now() + 1_000,
    version: 'failed-turn-1',
    failureReason: 'usage_limit_reached',
    viewMode: 'chat'
  }
}

type ExecutorState = {
  created: Map<string, { paneKey: string }>
  writes: string[]
  onPrompt?: (text: string) => void
}

function harness(options: { persisted?: PromptQueues; executor?: ExecutorState } = {}) {
  const state = { promptQueues: options.persisted ?? {} } as unknown as PersistedState
  const journal: string[] = []
  const snapshots: { phase: string; queues: PromptQueues }[] = []
  const executor: ExecutorState = options.executor ?? { created: new Map(), writes: [] }
  const persistence = new PromptQueuePersistence(
    {
      state,
      flushOrThrow: () => {
        const phase = state.promptQueues?.[sourceKey]?.recovery?.phase ?? 'none'
        journal.push(`flush:${phase}`)
        snapshots.push({ phase, queues: JSON.parse(JSON.stringify(state.promptQueues)) })
      }
    },
    {} as WriteSchedulingOperations
  )
  const controls = {
    candidates: [failure()],
    chains: [] as SessionChain[],
    accounts: [account('claude', 'source'), account('codex', 'replacement')],
    canStop: true as boolean | null,
    createSupport: true as boolean | null,
    stopRequested: false,
    owned: false
  }
  const stop = vi.fn(async () => {
    journal.push('stop')
    return controls.canStop
  })
  const create = vi.fn(
    async (
      _workspace: string,
      input: {
        tabId: string
        leafId: string
        agentSessionCreateOperationId: string
        beforeSpawn: () => void
      }
    ) => {
      input.beforeSpawn()
      journal.push('create')
      const key = input.agentSessionCreateOperationId
      if (!executor.created.has(key)) {
        executor.created.set(key, { paneKey: `${input.tabId}:${input.leafId}` })
      }
      return executor.created.get(key)!
    }
  )
  const runtime = {
    supportsConversationCapacityRecovery: async () => controls.createSupport,
    getLocalProvider: () => null,
    listPromptQueues: () => persistence.listPromptQueues(),
    readPromptQueue: (key: string) => persistence.readPromptQueue(key),
    saveConversationCapacityRecoveryAndFlush: (
      address: ConversationSource,
      recovery: ConversationCapacityRecovery | null
    ) => persistence.saveConversationCapacityRecoveryAndFlush(address, recovery),
    enqueuePromptQueueEntry: (address: ConversationSource, entry: unknown) =>
      persistence.enqueuePromptQueueEntry(address, entry),
    markPromptQueueEntrySendingAndFlush: (
      key: string,
      entryId: string,
      delivery: { operationId: string; deliveryEpoch: string }
    ) => persistence.markPromptQueueEntrySendingAndFlush(key, entryId, delivery),
    settlePromptQueueEntry: (
      key: string,
      entryId: string,
      settlement: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>[2]
    ) => persistence.settlePromptQueueEntry(key, entryId, settlement),
    listSessionChains: () => controls.chains,
    isPtyStopRequested: () => controls.stopRequested,
    hasConversationCapacityOwner: () => controls.owned,
    listConversationCapacityFailures: () => controls.candidates,
    getAccountsSnapshot: () => ({
      rateLimits: {
        accountCapacity: {
          claude: controls.accounts.filter((row) => row.provider === 'claude'),
          codex: controls.accounts.filter((row) => row.provider === 'codex'),
          builtAt: Date.now()
        }
      }
    }),
    validateOrchestrationAgentLauncher: () => {},
    refreshAccountsForMobileSubscriber: async () => {},
    resolveConversationCapacityWorkspace: async () => '/workspace',
    stopConversationCapacitySource: stop,
    createTerminal: create,
    resolveTerminalPane: (paneKey: string) => ({ handle: paneKey, worktreeId: source.worktreeId }),
    getFreshAgentHookStatusForHandle: (handle: string) =>
      handle === source.paneKey
        ? { state: 'done', failed: true, failureReason: 'usage_limit_reached', stateStartedAt: 1 }
        : {
            ...normalizeHookPayload(
              createHookListenerState(),
              'codex',
              {
                paneKey: handle,
                env: 'production',
                version: '1',
                payload: {
                  hook_event_name: 'SessionStart',
                  source: 'startup',
                  session_id: 'successor-session'
                }
              },
              'production'
            )!.payload,
            stateStartedAt: 1
          },
    getTerminalPaneKey: (handle: string) => handle,
    getTerminalProcessIncarnation: () => 'replacement-incarnation',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    sendTerminalAgentPrompt: async (
      _handle: string,
      text: string,
      input: { beforeWrite: () => void }
    ) => {
      input.beforeWrite()
      journal.push('write')
      executor.writes.push(text)
      executor.onPrompt?.(text)
    }
  } as unknown as OrcaRuntimeService
  return { runtime, state, persistence, journal, snapshots, executor, controls, stop, create }
}

describe('capacity recovery account selection', () => {
  it('prefers an eligible same-family account and otherwise selects another family', () => {
    const sameFamily = account('claude', 'backup')
    const otherFamily = account('codex', 'replacement', { isDefault: true })
    const rows = [account('claude', 'source'), otherFamily, sameFamily]
    expect(selectCapacityRecoveryAccount(rows, 'claude', '/accounts/source', [])).toEqual(
      sameFamily
    )
    expect(
      selectCapacityRecoveryAccount(rows, 'claude', '/accounts/source', [
        capacityRecoveryAccountKey(sameFamily)
      ])
    ).toEqual(otherFamily)
  })

  it('does not mistake another profile of the exhausted billing account for fresh capacity', () => {
    const rows = [
      account('claude', 'source'),
      account('claude', 'alias', { email: 'source@example.test' }),
      account('codex', 'replacement')
    ]
    expect(selectCapacityRecoveryAccount(rows, 'claude', '/accounts/source', [])?.provider).toBe(
      'codex'
    )
  })

  it.each(['limited', 'signed-out', 'checking', 'usable'] as const)(
    'does not automatically spend an account with %s capacity',
    (state) => {
      expect(
        selectCapacityRecoveryAccount(
          [account('codex', 'replacement', { state })],
          'claude',
          '/accounts/source',
          []
        )
      ).toBeNull()
    }
  )

  it('requires a usable launch home and current unexhausted capacity evidence', () => {
    const rows = [
      account('codex', 'no-home', { launchEnv: null }),
      account('codex', 'stale', { readingAt: Date.now() - 6 * 60_000 }),
      account('claude', 'exhausted', {
        weekly: { remainingPercent: 0, resetsAt: Date.now() + 10_000, windowMinutes: 10_080 }
      })
    ]
    expect(selectCapacityRecoveryAccount(rows, 'claude', '/accounts/source', [])).toBeNull()
  })

  it('does not charge known non-Fable Claude models against the Fable-only bucket', () => {
    const backup = account('claude', 'backup', {
      fableWeekly: { remainingPercent: 0, resetsAt: Date.now() + 10_000, windowMinutes: 10_080 }
    })
    for (const model of ['opus[1m]', 'claude-opus-4-6', 'sonnet', 'haiku']) {
      expect(
        selectCapacityRecoveryAccount([backup], 'claude', '/accounts/source', [], model)
      ).toEqual(backup)
    }
    for (const model of ['fable', 'fable[1m]', 'default', undefined]) {
      expect(
        selectCapacityRecoveryAccount([backup], 'claude', '/accounts/source', [], model)
      ).toBeNull()
    }
    expect(
      selectCapacityRecoveryAccount([backup], 'codex', '/accounts/source', [], 'gpt-5')
    ).toBeNull()
    backup.weekly = { remainingPercent: 0, resetsAt: Date.now() + 10_000, windowMinutes: 10_080 }
    expect(
      selectCapacityRecoveryAccount([backup], 'claude', '/accounts/source', [], 'opus[1m]')
    ).toBeNull()
  })
})

describe('conversation capacity recovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('holds before stopping the source when the provider cannot deduplicate replacement creation', async () => {
    const test = harness()
    test.controls.createSupport = false
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.stop).not.toHaveBeenCalled()
    expect(test.create).not.toHaveBeenCalled()
    expect(test.persistence.readPromptQueue(sourceKey)?.recovery).toMatchObject({
      phase: 'held',
      reason: expect.stringContaining('durable session creation')
    })
  })

  it('retains the successor address without reviving recovery cancelled while creation was pending', async () => {
    const test = harness()
    const create = test.create.getMockImplementation()!
    test.create.mockImplementationOnce(async (...args) => {
      const successor = await create(...args)
      const saved = test.persistence.readPromptQueue(sourceKey)!.recovery!
      test.persistence.saveConversationCapacityRecoveryAndFlush(source, {
        ...saved,
        phase: 'cancelled',
        reason: 'New terminal input.'
      })
      return successor
    })
    await advanceConversationCapacityRecovery(test.runtime)
    await drainPromptQueues(test.runtime, { epoch: 'runtime' })
    const saved = test.persistence.readPromptQueue(sourceKey)!.recovery!
    expect(saved).toMatchObject({ phase: 'cancelled', reason: 'New terminal input.' })
    expect(saved.successor?.source?.paneKey).toBe(
      `${saved.successor!.tabId}:${saved.successor!.leafId}`
    )
    expect(test.executor.created.size).toBe(1)
    expect(test.executor.writes).toHaveLength(0)
  })

  it('preserves Opus on an eligible Claude replacement even when its Fable bucket is exhausted', async () => {
    const test = harness()
    test.controls.candidates[0]!.model = 'opus[1m]'
    test.controls.accounts = [
      account('claude', 'backup', {
        fableWeekly: {
          remainingPercent: 0,
          resetsAt: Date.now() + 10_000,
          windowMinutes: 10_080
        }
      })
    ]
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.create).toHaveBeenCalledWith(
      'id:workspace',
      expect.objectContaining({
        startupAgent: 'claude',
        launchPreferences: { model: 'opus[1m]' },
        agentLaunchEnv: { CLAUDE_CONFIG_DIR: '/accounts/backup' }
      })
    )
  })

  it('continues a Codex run that hit its usage limit on another Codex account with the same model', async () => {
    const test = harness()
    test.controls.candidates = [
      {
        ...failure(),
        agent: 'codex',
        transcriptPath: '/accounts/source/sessions/2026/10/01/rollout.jsonl',
        failureReason: 'You’ve hit your usage limit. Try again at 3:04 PM.',
        model: 'gpt-5.5'
      }
    ]
    test.controls.accounts = [
      account('codex', 'source', {
        state: 'limited',
        fiveHour: {
          remainingPercent: 0,
          resetsAt: Date.now() + 60_000,
          windowMinutes: 300
        }
      }),
      account('claude', 'other'),
      account('codex', 'backup')
    ]
    await advanceConversationCapacityRecovery(test.runtime)
    const recovery = test.persistence.readPromptQueue(sourceKey)!.recovery!
    expect(recovery).toMatchObject({
      phase: 'created',
      sourceAgent: 'codex',
      sourceAccountHome: '/accounts/source',
      target: {
        agent: 'codex',
        accountHome: '/accounts/backup',
        model: 'gpt-5.5'
      },
      attemptAccounts: ['codex:/accounts/source']
    })
    expect(test.journal.indexOf('stop')).toBeLessThan(test.journal.indexOf('create'))
    expect(test.create).toHaveBeenCalledExactlyOnceWith(
      'id:workspace',
      expect.objectContaining({
        startupAgent: 'codex',
        launchPreferences: { model: 'gpt-5.5' },
        agentLaunchEnv: { CODEX_HOME: '/accounts/backup' }
      })
    )
    await drainPromptQueues(test.runtime, { epoch: 'first-runtime' })
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.executor.writes).toEqual(['Continue the original request; check the saved edit.'])
    expect(test.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('delivered')
  })

  it('persists ownership before stopping, creates one replacement and uses the existing drain once', async () => {
    const test = harness()
    await advanceConversationCapacityRecovery(test.runtime)
    const recovery = test.persistence.readPromptQueue(sourceKey)!.recovery!
    expect(recovery.phase).toBe('created')
    expect(test.journal.indexOf('flush:prepared')).toBeLessThan(test.journal.indexOf('stop'))
    expect(test.journal.indexOf('flush:stopped')).toBeLessThan(test.journal.indexOf('create'))
    expect(test.create).toHaveBeenCalledWith(
      'id:workspace',
      expect.objectContaining({
        startupAgent: 'codex',
        agentLaunchEnv: { CODEX_HOME: '/accounts/replacement' },
        viewMode: 'chat',
        agentSessionCreateOperationId: recovery.successor!.operationId,
        preAllocatedHandle: recovery.successor!.handle
      })
    )
    // Latency telemetry: an automatic successor names no launch cause, so its spawn records
    // 'unknown' and a recovery burst is never attributed to a person's CLI.
    expect(test.create).toHaveBeenCalledWith(
      'id:workspace',
      expect.not.objectContaining({ launchTrigger: expect.anything() })
    )
    await drainPromptQueues(test.runtime, { epoch: 'first-runtime' })
    await advanceConversationCapacityRecovery(test.runtime)
    await drainPromptQueues(test.runtime, { epoch: 'first-runtime' })
    expect(test.executor.created.size).toBe(1)
    expect(test.executor.writes).toEqual(['Continue the original request; check the saved edit.'])
    expect(test.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('delivered')
  })

  it.each(['prepared', 'stopped', 'created'] as const)(
    'resumes a saved %s phase after restart without creating a second executor or delivery',
    async (phase) => {
      const initial = harness()
      await advanceConversationCapacityRecovery(initial.runtime)
      const saved = initial.snapshots.find((snapshot) => snapshot.phase === phase)!
      const restarted = harness({
        persisted: normalizePromptQueues(saved.queues),
        executor: initial.executor
      })
      restarted.controls.candidates = []
      await advanceConversationCapacityRecovery(restarted.runtime)
      await drainPromptQueues(restarted.runtime, { epoch: 'restarted-runtime' })
      await advanceConversationCapacityRecovery(restarted.runtime)
      await drainPromptQueues(restarted.runtime, { epoch: 'restarted-runtime' })
      expect(restarted.executor.created.size).toBe(1)
      expect(restarted.executor.writes).toHaveLength(1)
      expect(restarted.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('delivered')
    }
  )

  it('holds when the original executor cannot be confirmed stopped', async () => {
    const test = harness()
    test.controls.canStop = false
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.create).not.toHaveBeenCalled()
    expect(test.persistence.readPromptQueue(sourceKey)?.recovery).toMatchObject({
      phase: 'held',
      reason: expect.stringContaining('confirmed stopped')
    })
  })

  it('defers an unready restart stop proof and takes over once when the same source becomes verifiable', async () => {
    const test = harness()
    test.controls.canStop = null
    await advanceConversationCapacityRecovery(test.runtime)
    const pending = test.persistence.readPromptQueue(sourceKey)!.recovery!
    expect(pending.phase).toBe('prepared')
    expect(test.create).not.toHaveBeenCalled()
    expect(test.executor.writes).toHaveLength(0)

    test.controls.canStop = true
    await advanceConversationCapacityRecovery(test.runtime)
    await drainPromptQueues(test.runtime, { epoch: 'recovered-runtime' })
    await advanceConversationCapacityRecovery(test.runtime)
    await drainPromptQueues(test.runtime, { epoch: 'recovered-runtime' })
    const delivered = test.persistence.readPromptQueue(sourceKey)!.recovery!
    expect(delivered.id).toBe(pending.id)
    expect(delivered.successor?.operationId).toBe(pending.successor?.operationId)
    expect(delivered.phase).toBe('delivered')
    expect(test.create).toHaveBeenCalledTimes(1)
    expect(test.executor.created.size).toBe(1)
    expect(test.executor.writes).toHaveLength(1)
  })

  it('continues a partially edited real file through the recovered queue without another human prompt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'capacity-recovery-'))
    const page = join(directory, 'index.html')
    try {
      // The interrupted provider applied the headline; the authorized footer edit remains.
      writeFileSync(page, '<h1>Requested headline</h1><footer>Old footer</footer>')
      const test = harness()
      let checked = false
      test.executor.onPrompt = () => {
        const partial = readFileSync(page, 'utf8')
        expect(partial).toContain('<h1>Requested headline</h1>')
        writeFileSync(page, partial.replace('Old footer', 'Requested footer'))
        checked =
          readFileSync(page, 'utf8') ===
          '<h1>Requested headline</h1><footer>Requested footer</footer>'
      }
      await advanceConversationCapacityRecovery(test.runtime)
      const restarted = harness({
        persisted: normalizePromptQueues(JSON.parse(JSON.stringify(test.state.promptQueues))),
        executor: test.executor
      })
      restarted.controls.candidates = []
      await advanceConversationCapacityRecovery(restarted.runtime)
      await drainPromptQueues(restarted.runtime, { epoch: 'restarted-runtime' })
      await advanceConversationCapacityRecovery(restarted.runtime)
      await drainPromptQueues(restarted.runtime, { epoch: 'restarted-runtime' })
      expect(checked).toBe(true)
      expect(readFileSync(page, 'utf8')).toBe(
        '<h1>Requested headline</h1><footer>Requested footer</footer>'
      )
      expect(restarted.executor.created.size).toBe(1)
      expect(restarted.executor.writes).toHaveLength(1)
      expect(restarted.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('delivered')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not compete with an active Outcome controller or queued human steering', async () => {
    const controlled = harness()
    controlled.controls.chains = [
      {
        worktreeId: source.worktreeId,
        sourcePaneKey: source.paneKey,
        state: 'active',
        steps: [{}],
        currentIndex: 0
      } as unknown as SessionChain
    ]
    await advanceConversationCapacityRecovery(controlled.runtime)
    expect(controlled.stop).not.toHaveBeenCalled()
    const steered = harness()
    steered.persistence.enqueuePromptQueueEntry(source, {
      id: 'human',
      text: 'Stop editing; only report.',
      createdAt: Date.now(),
      state: 'queued'
    })
    await advanceConversationCapacityRecovery(steered.runtime)
    expect(steered.stop).not.toHaveBeenCalled()
    expect(steered.persistence.readPromptQueue(sourceKey)?.recovery).toBeUndefined()
  })

  it('rechecks source identity after preparing history so newer steering wins', async () => {
    const test = harness()
    vi.mocked(writeFile).mockImplementationOnce(async () => {
      test.controls.candidates = []
    })
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.stop).not.toHaveBeenCalled()
    expect(test.persistence.readPromptQueue(sourceKey)).toBeNull()
  })

  it.each(['stop', 'steering', 'owner'] as const)(
    'does not deliver queued recovery after a newer %s takes precedence',
    async (change) => {
      const test = harness()
      await advanceConversationCapacityRecovery(test.runtime)
      const recovery = test.persistence.readPromptQueue(sourceKey)!.recovery!
      if (change === 'stop') {
        test.controls.stopRequested = true
      }
      if (change === 'owner') {
        test.controls.owned = true
      }
      if (change === 'steering') {
        test.persistence.enqueuePromptQueueEntry(source, {
          id: 'human',
          text: 'Stop editing; only report.',
          createdAt: Date.now(),
          state: 'queued'
        })
      }
      await drainPromptQueues(test.runtime, { epoch: 'runtime' })
      const automaticWrites = test.executor.writes.filter((text) => text === recovery.brief)
      expect(automaticWrites).toHaveLength(0)
      const target = test.persistence.readPromptQueue(
        conversationSourceRowKey(recovery.successor!.source!)
      )!
      expect(target.entries.find((entry) => entry.id === recovery.id)?.state).toBe('failed')
    }
  )

  it('carries paused child history without promoting delegated instructions to human authority', async () => {
    const test = harness()
    test.controls.candidates[0]!.childTranscriptPath =
      '/accounts/source/subagents/agent-paused.jsonl'
    vi.mocked(readCompleteSessionTranscript)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'child-user',
          role: 'user',
          timestamp: Date.now(),
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Verify the join plan.' }]
        },
        {
          id: 'child-result',
          role: 'assistant',
          timestamp: Date.now(),
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Checked pairing. Jira needs enrollment.' }]
        }
      ])
    await advanceConversationCapacityRecovery(test.runtime)
    expect(readCompleteSessionTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agent: 'claude',
        sessionId: 'source-session',
        transcriptPath: '/accounts/source/subagents/agent-paused.jsonl'
      })
    )
    expect(buildCapacityRecoveryBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ id: 'child-user', role: 'tool' }),
          expect.objectContaining({ id: 'child-result', role: 'assistant' })
        ]
      })
    )
    expect(test.journal.indexOf('stop')).toBeLessThan(test.journal.indexOf('create'))
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.create).toHaveBeenCalledTimes(1)
  })

  it('does not turn missing capacity into completion, a human request or another launch', async () => {
    const test = harness()
    test.controls.accounts = [account('claude', 'source')]
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.stop).not.toHaveBeenCalled()
    expect(test.create).not.toHaveBeenCalled()
    expect(test.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('waiting-capacity')
  })

  it('durably holds an unsafe brief instead of rereading and retrying the same failed preparation', async () => {
    const test = harness()
    vi.mocked(buildCapacityRecoveryBrief).mockImplementationOnce(() => {
      throw new Error('Protected data prevented safe handoff.')
    })
    await advanceConversationCapacityRecovery(test.runtime)
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.persistence.readPromptQueue(sourceKey)?.recovery).toMatchObject({
      phase: 'held',
      sourceVersion: 'failed-turn-1',
      reason: 'Protected data prevented safe handoff.'
    })
    expect(readCompleteSessionTranscript).toHaveBeenCalledTimes(1)
    expect(buildCapacityRecoveryBrief).toHaveBeenCalledTimes(1)
    expect(writeFile).not.toHaveBeenCalled()
    expect(test.stop).not.toHaveBeenCalled()
    expect(test.create).not.toHaveBeenCalled()
    expect(test.executor.writes).toHaveLength(0)
  })

  it('wakes a durable capacity wait after restart when an eligible account becomes available', async () => {
    const initial = harness()
    initial.controls.accounts = [account('claude', 'source')]
    await advanceConversationCapacityRecovery(initial.runtime)
    expect(initial.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('waiting-capacity')
    const restarted = harness({
      persisted: normalizePromptQueues(JSON.parse(JSON.stringify(initial.state.promptQueues))),
      executor: initial.executor
    })
    restarted.controls.candidates = []
    restarted.controls.accounts = [account('claude', 'source')]
    await advanceConversationCapacityRecovery(restarted.runtime)
    expect(restarted.create).not.toHaveBeenCalled()
    restarted.controls.accounts.push(account('codex', 'replacement'))
    await advanceConversationCapacityRecovery(restarted.runtime)
    await drainPromptQueues(restarted.runtime, { epoch: 'restarted-runtime' })
    await advanceConversationCapacityRecovery(restarted.runtime)
    expect(restarted.executor.created.size).toBe(1)
    expect(restarted.executor.writes).toHaveLength(1)
    expect(restarted.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('delivered')
  })

  it('reuses the original account only after a known reset and a fresh ready reading after that reset', async () => {
    const test = harness()
    test.controls.accounts = [account('claude', 'source')]
    await advanceConversationCapacityRecovery(test.runtime)
    const waiting = test.persistence.readPromptQueue(sourceKey)!.recovery!
    const now = Date.now()
    const reset = { ...waiting, sourceResetAt: now - 1_000, sourceModel: 'fable' }
    test.controls.accounts[0]!.readingAt = now - 2_000
    expect(assignCapacityRecoveryTarget(test.runtime, reset, now)).toBeNull()
    test.controls.accounts[0]!.readingAt = now
    expect(
      assignCapacityRecoveryTarget(
        test.runtime,
        {
          ...reset,
          sourceResetAt: now + 1_000
        },
        now
      )
    ).toBeNull()
    test.controls.accounts[0]!.state = 'limited'
    expect(assignCapacityRecoveryTarget(test.runtime, reset, now)).toBeNull()
    test.controls.accounts[0]!.state = 'ready'
    expect(assignCapacityRecoveryTarget(test.runtime, reset, now)?.target).toMatchObject({
      agent: 'claude',
      accountHome: '/accounts/source',
      model: 'fable'
    })
    expect(assignCapacityRecoveryTarget(test.runtime, waiting, now)).toBeNull()
  })

  it('does not replay an unconfirmed delivery after restart', async () => {
    const initial = harness()
    await advanceConversationCapacityRecovery(initial.runtime)
    const recovery = initial.persistence.readPromptQueue(sourceKey)!.recovery!
    const targetKey = conversationSourceRowKey(recovery.successor!.source!)
    initial.persistence.markPromptQueueEntrySendingAndFlush(targetKey, recovery.id, {
      operationId: 'uncertain-operation',
      deliveryEpoch: 'old-runtime'
    })
    const restarted = harness({
      persisted: normalizePromptQueues(JSON.parse(JSON.stringify(initial.state.promptQueues))),
      executor: initial.executor
    })
    restarted.controls.candidates = []
    await drainPromptQueues(restarted.runtime, { epoch: 'new-runtime' })
    await advanceConversationCapacityRecovery(restarted.runtime)
    expect(restarted.executor.writes).toHaveLength(0)
    expect(restarted.persistence.readPromptQueue(sourceKey)?.recovery?.phase).toBe('held')
    expect(restarted.persistence.readPromptQueue(targetKey)?.entries[0]).toMatchObject({
      state: 'failed'
    })
  })

  it('carries the original history and exhausted accounts through a second provider takeover', async () => {
    const test = harness()
    await advanceConversationCapacityRecovery(test.runtime)
    await drainPromptQueues(test.runtime, { epoch: 'runtime' })
    await advanceConversationCapacityRecovery(test.runtime)
    const first = test.persistence.readPromptQueue(sourceKey)!.recovery!
    const replacementSource = first.successor!.source!
    test.controls.accounts.push(account('claude', 'third'))
    test.controls.candidates = [
      {
        ...failure(),
        source: replacementSource,
        handle: first.successor!.handle,
        ptyId: 'replacement-pty',
        processIncarnation: 'replacement-incarnation',
        agent: 'codex',
        providerSessionId: 'replacement-session',
        transcriptPath: '/accounts/replacement/transcript.jsonl',
        accountHome: '/accounts/replacement',
        version: 'failed-turn-2'
      }
    ]
    await advanceConversationCapacityRecovery(test.runtime)
    const second = test.persistence.readPromptQueue(
      conversationSourceRowKey(replacementSource)
    )!.recovery!
    expect(second.target?.accountHome).toBe('/accounts/third')
    expect(second.attemptAccounts).toEqual([
      'claude:/accounts/source',
      'codex:/accounts/replacement'
    ])
    expect(
      vi
        .mocked(readCompleteSessionTranscript)
        .mock.calls.map(([request]) => (request.kind === 'provider' ? request.sessionId : null))
    ).toEqual(['source-session', 'source-session', 'replacement-session'])
    await drainPromptQueues(test.runtime, { epoch: 'runtime' })
    await advanceConversationCapacityRecovery(test.runtime)
    expect(test.executor.created.size).toBe(2)
    expect(test.executor.writes).toHaveLength(2)
  })
})
