import {
  closeWriteFence,
  isWriteFenceOpen,
  openWriteFence
} from '../runtime/conversation-write-fence'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hookListeners: new Set<(event: unknown) => void>(),
  teardownListener: null as ((paneKey: string) => void) | null,
  unsubscribeHooks: vi.fn(),
  unsubscribeTeardown: vi.fn(),
  generate: vi.fn()
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (event: unknown) => void) => {
      mocks.hookListeners.add(listener)
      return () => {
        mocks.hookListeners.delete(listener)
        mocks.unsubscribeHooks()
      }
    },
    getStatusSnapshotForPane: () => []
  }
}))
vi.mock('../ipc/pty/pane/key-state', () => ({
  registerPaneKeyTeardownListener: (listener: (paneKey: string) => void) => {
    mocks.teardownListener = listener
    return mocks.unsubscribeTeardown
  }
}))
vi.mock('./next-step-suggestion-generator', () => ({ generateNextSteps: mocks.generate }))

import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { getNextStepSuggestionService, onNextStepTurnSignal } from './next-step-suggestion-slot'
import { NEXT_STEP_INTERRUPTED_REASON, NEXT_STEP_SETS_FILE } from './next-step-suggestion-store'
import { startNextStepSuggestions } from './next-step-suggestion-wiring'

let dir: string
let settings: { nextStepSuggestions?: { enabled: boolean } }
let signals: AbortSignal[]

// A real workspace this host resolves: every pane below is in `repo::/w`.
const store = {
  getSettings: () => settings,
  getRepo: (id: string) => (id === 'repo' ? { id, kind: 'git', connectionId: null } : undefined),
  getFolderWorkspaces: () => []
} as unknown as Store
const runtime = {
  getTerminalWorktreeIdForPaneKey: () => 'repo::/w',
  getArtifactApiOrigin: () => null,
  readPromptQueue: () => null,
  listSessionChains: () => [],
  listPromptQueues: () => ({}),
  settlePromptQueueEntry: vi.fn(),
  enqueuePromptQueueEntry: vi.fn(),
  getCommitMessageAgentEnvironmentResolvers: () => undefined,
  getRuntimeGitStatus: vi.fn()
} as unknown as OrcaRuntimeService

const stop = (paneKey: string, at: number) =>
  mocks.hookListeners.forEach((listener) =>
    listener({
      paneKey,
      connectionId: null,
      hookEventName: 'Stop',
      stateStartedAt: at,
      receivedAt: at,
      payload: { state: 'done', prompt: '', agentType: 'claude', lastAssistantMessage: 'Done.' }
    })
  )

beforeEach(() => {
  mocks.hookListeners.clear()
  dir = mkdtempSync(join(tmpdir(), 'next-steps-wiring-'))
  settings = {}
  signals = []
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  mocks.generate.mockReset()
  mocks.generate.mockImplementation(
    (_deps: unknown, _turn: unknown, signal: AbortSignal) =>
      new Promise((resolve) => {
        signals.push(signal)
        signal.addEventListener('abort', () =>
          resolve({ ok: false, error: 'Generation canceled.' })
        )
      })
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('startNextStepSuggestions', () => {
  it('revokes the prior event before capturing a finished-turn checkpoint', async () => {
    const dispose = startNextStepSuggestions({ store, runtime, userDataPath: dir })
    let checkpoint = ''
    const unsubscribe = onNextStepTurnSignal((signal) => {
      if (signal.kind === 'finished') {
        checkpoint = openWriteFence(signal.turn.conversation, () => true)
      }
    })
    try {
      stop('tab:leaf', 1)
      const first = checkpoint
      expect(first).not.toBe('')
      expect(isWriteFenceOpen(first)).toBe(true)
      stop('tab:leaf', 2)
      expect(isWriteFenceOpen(first)).toBe(false)
      expect(isWriteFenceOpen(checkpoint)).toBe(true)
    } finally {
      closeWriteFence(checkpoint)
      unsubscribe()
      await dispose()
    }
  })

  it('loads saved sets at boot, reading an interrupted generation as failed', async () => {
    writeFileSync(
      join(dir, NEXT_STEP_SETS_FILE),
      JSON.stringify({
        sets: [
          {
            id: 'old',
            conversation: { worktreeId: 'repo::/w', paneKey: 'tab:leaf', kind: 'pty' },
            worktreeId: 'repo::/w',
            turnKey: 'tab:leaf@1',
            origin: 'ai',
            createdAt: Date.now(),
            status: 'generating',
            suggestions: []
          }
        ]
      })
    )
    const dispose = startNextStepSuggestions({ store, runtime, userDataPath: dir })
    expect(getNextStepSuggestionService()!.list().sets).toMatchObject([
      { id: 'old', status: 'failed', error: NEXT_STEP_INTERRUPTED_REASON }
    ])
    await dispose()
  })

  it('reads the setting when a turn ends, not once at start', async () => {
    settings = { nextStepSuggestions: { enabled: false } }
    const dispose = startNextStepSuggestions({ store, runtime, userDataPath: dir })
    stop('tab:leaf', 1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(getNextStepSuggestionService()!.list().skips[0]!.reason).toMatch(/turned off/)

    settings = {}
    stop('tab:leaf', 2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    await dispose()
  })

  it('a pane teardown aborts that pane’s call', async () => {
    const dispose = startNextStepSuggestions({ store, runtime, userDataPath: dir })
    stop('tab:leaf', 1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(signals).toHaveLength(1)
    mocks.teardownListener!('tab:leaf')
    expect(signals[0]!.aborted).toBe(true)
    await dispose()
  })

  it('dispose unsubscribes, clears the slot and settles the pending writes', async () => {
    const dispose = startNextStepSuggestions({ store, runtime, userDataPath: dir })
    expect(getNextStepSuggestionService()).not.toBeNull()
    await expect(dispose()).resolves.toBeUndefined()
    expect(mocks.unsubscribeHooks).toHaveBeenCalled()
    expect(mocks.unsubscribeTeardown).toHaveBeenCalled()
    expect(getNextStepSuggestionService()).toBeNull()
  })

  it('two conversations in one resolved workspace never run at once, and A never aborts B', async () => {
    const dispose = startNextStepSuggestions({ store, runtime, userDataPath: dir })
    const turnOf = (index: number) =>
      (mocks.generate.mock.calls[index]![1] as { conversation: { paneKey: string } }).conversation
        .paneKey
    stop('tab-a:leaf', 1)
    stop('tab-b:leaf', 1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(signals).toHaveLength(1)
    expect(turnOf(0)).toBe('tab-a:leaf')

    // A's newer turn supersedes A; B, queued in the same workspace, is untouched and runs next.
    stop('tab-a:leaf', 2)
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(signals).toHaveLength(2)
    expect(turnOf(1)).toBe('tab-b:leaf')
    const b = signals[1]!

    mocks.teardownListener!('tab-a:leaf')
    stop('tab-a:leaf', 3)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(b.aborted).toBe(false)
    // A waits behind B: still never two calls at once in this workspace.
    expect(signals).toHaveLength(2)
    await dispose()
  })
})
