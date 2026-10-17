import { describe, expect, it, vi } from 'vitest'

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

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import type { PersistedState } from '../../shared/persisted-state-types'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { ConversationCapacityRecovery, PromptQueues } from '../../shared/prompt-queue-types'
import type { AccountCapacityRow } from '../../shared/provider-account-capacity'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  advanceConversationCapacityRecovery,
  type CapacityRecoveryCandidate
} from './conversation-capacity-recovery'
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

describe('capacity recovery launch provenance', () => {
  it('passes the durable recovery id and source pane to createTerminal', async () => {
    const test = harness()
    await advanceConversationCapacityRecovery(test.runtime)
    const recoveryId = test.persistence.readPromptQueue(sourceKey)?.recovery?.id
    expect(recoveryId).toEqual(expect.any(String))
    expect(
      (test.create.mock.calls[0]?.[1] as unknown as { launchCause: unknown })?.launchCause
    ).toEqual({
      trigger: 'capacity-recovery',
      reference: { recoveryId },
      parentPaneKey: source.paneKey
    })
  })
})
