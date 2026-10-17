import { restoreCompiledLegacyChain } from './session-chain-legacy.fixture'
// Compat gate for the review boundary of a session chain: every reviewer's machine
// verdict (OMNI_REVIEW_RESULT) is read before anything else may launch, findings reach
// the repair step's brief, a clean fan-out skips the repair, and the round limit parks
// the chain instead of looping. The pipeline flavour of this (builder + reviewers over
// rounds on the Run mailbox) is covered by build-review-service.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_REVIEW_RESULT_MARKER } from '../../../shared/session-chain-review'
import type { SessionChainStep } from '../../../shared/session-chain-types'

const client = vi.hoisted(() => ({
  listSessionChainsFromHost: vi.fn(),
  upsertSessionChainOnHost: vi.fn(),
  removeSessionChainOnHost: vi.fn(),
  listSessionChainOutputFilesFromHost: vi.fn(),
  readTerminalTailFromHost: vi.fn()
}))
const launch = vi.hoisted(() => ({ launchAgentSessionContinuation: vi.fn() }))
const waits = vi.hoisted(() => {
  class SourceSessionFailedError extends Error {}
  class SourceSessionBlockedError extends SourceSessionFailedError {
    reason = 'prompt'
    paneKey: string | null = null
  }
  return {
    SourceSessionFailedError,
    SourceSessionBlockedError,
    waitForSourceSessionCompletion: vi.fn(),
    createTerminalWaitDependencies: vi.fn()
  }
})
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    activeWorktreeId: 'folder:f1' as string | null,
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    terminalLayoutsByTabId: {} as Record<string, { root: unknown; activeLeafId: string | null }>,
    agentStatusByPaneKey: {} as Record<string, { state: string; updatedAt: number }>,
    getKnownWorktreeById: (id: string) =>
      id === 'folder:f1' ? { path: '/Users/me/Webinar' } : undefined
  }
  return {
    state,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: () => {
      for (const listener of listeners) {
        listener()
      }
    }
  }
})

vi.mock('@/lib/session-chain-client', () => client)
vi.mock('@/lib/launch-agent-session-continuation', () => launch)
vi.mock('@/lib/next-session-launch', () => waits)
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: unknown) => unknown) => selector(store.state), {
    getState: store.getState,
    subscribe: store.subscribe
  })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
}))
vi.mock('@/components/terminal-pane/terminal-layout-leaf-ids', () => ({
  collectLeafIdsInOrder: (root: unknown) =>
    root && typeof root === 'object' && 'leafId' in root
      ? [(root as { leafId: string }).leafId]
      : [],
  resolveRootlessTerminalLayoutLeafId: () => null
}))
vi.mock('../../../shared/stable-pane-id', () => ({
  isTerminalLeafId: () => true,
  makePaneKey: (tabId: string, leaf: string) => `${tabId}:${leaf}`
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

const session = {
  rowKey: '["local","folder:f1","tab-src:leaf-1"]',
  sessionKey: null,
  worktreeId: 'folder:f1',
  hostId: 'local' as const,
  tabId: 'tab-src',
  paneKey: 'tab-src:leaf-1',
  kind: 'terminal' as const,
  label: 'Candidate session',
  workspaceLabel: 'Webinar',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

const FINDING = 'The submit path can send the prompt twice.'

function verdictLine(status: 'pass' | 'findings', findings: string[] = []): string {
  return `Reviewed the change.\n${SESSION_REVIEW_RESULT_MARKER}${JSON.stringify({
    status,
    blockingFindings: findings
  })}`
}

function reviewSteps(maxRounds: number): SessionChainStep[] {
  const review = (reviewerId: string) => ({
    groupId: 'g1',
    reviewerId,
    round: 1,
    maxRounds,
    candidateVersion: 'v1'
  })
  return [
    {
      id: 'rev1',
      agent: 'claude',
      prompt: 'review the candidate',
      presetId: 'review',
      group: 'g1',
      review: review('r1'),
      status: 'queued'
    },
    {
      id: 'rev2',
      agent: 'codex',
      prompt: 'review the candidate',
      presetId: 'review',
      group: 'g1',
      review: review('r2'),
      status: 'queued'
    },
    {
      id: 'fix',
      agent: 'claude',
      prompt: 'fix the blocking findings',
      presetId: 'improve',
      reviewRepair: {
        groupId: 'g1',
        afterRound: 1,
        candidateVersion: 'v1',
        consumptionKey: 'g1:1'
      },
      status: 'queued'
    }
  ] as unknown as SessionChainStep[]
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function importRunner() {
  const runner = await import('./session-chain-runner')
  runner.resetSessionChainsForTests()
  return { ...runner, restoreCompiledLegacyChain }
}

/** Verdict text each reviewer pane leaves on its terminal, by launch order. */
function scriptReviewerOutput(tails: string[]): void {
  client.readTerminalTailFromHost.mockImplementation(async (_target, handle: string) => {
    if (handle === 'term_tab-1:leaf-1') {
      return tails[0] ?? ''
    }
    if (handle === 'term_tab-2:leaf-2') {
      return tails[1] ?? ''
    }
    return 'the candidate session did the work'
  })
}

describe('the review boundary of a chain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    client.upsertSessionChainOnHost.mockImplementation(async (_target, chain) => chain)
    client.removeSessionChainOnHost.mockResolvedValue(undefined)
    client.listSessionChainOutputFilesFromHost.mockResolvedValue({
      outputDir: '/x',
      files: [],
      truncated: false
    })
    store.state.terminalLayoutsByTabId = {}
    store.state.agentStatusByPaneKey = {}
    store.state.activeWorktreeId = 'folder:f1'
    // Each pane resolves to its own handle so a reviewer's verdict cannot be read off
    // the wrong pane.
    waits.createTerminalWaitDependencies.mockImplementation(
      (_target: unknown, request: { sourcePaneKey: string }) => ({
        resolveSource: vi.fn().mockResolvedValue({ handle: `term_${request.sourcePaneKey}` }),
        waitForIdle: vi.fn(),
        waitForExit: vi.fn()
      })
    )
    waits.waitForSourceSessionCompletion.mockImplementation(
      (deps: { resolveSource: () => Promise<{ handle: string }> }) => deps.resolveSource()
    )
    let launches = 0
    launch.launchAgentSessionContinuation.mockImplementation(async (args) => {
      launches += 1
      const tabId = `tab-${launches}`
      const leafId = `leaf-${launches}`
      args.onLaunched?.({ tabId, promptDelivered: Promise.resolve(true) })
      store.state.terminalLayoutsByTabId[tabId] = { root: { leafId }, activeLeafId: leafId }
      const paneKey = `${tabId}:${leafId}`
      store.state.agentStatusByPaneKey[paneKey] = { state: 'working', updatedAt: Date.now() }
      store.emit()
      // The reviewer works for a moment, then its hooks report a clean finish.
      setTimeout(() => {
        store.state.agentStatusByPaneKey[paneKey] = { state: 'done', updatedAt: Date.now() }
        store.emit()
      }, 1_000)
      return true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries every reviewer’s blocking findings into the repair brief', async () => {
    const runner = await importRunner()
    scriptReviewerOutput([verdictLine('findings', [FINDING]), verdictLine('pass')])
    const chain = runner.restoreCompiledLegacyChain({
      session,
      chainId: 'chn_review',
      auto: true,
      steps: reviewSteps(2)
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)

    // Both reviewers ran, then the repair launched with both reviewer transcripts.
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(3)
    const repairPrompt = launch.launchAgentSessionContinuation.mock.calls[2]?.[0].prompt as string
    expect(repairPrompt).toContain('fix the blocking findings')
    expect(repairPrompt).toContain(FINDING)
    expect(repairPrompt).toContain('Result 1 of 2')
    const state = runner.getSessionChain(chain!.id)
    expect(state?.reviewLoop?.groups[0]).toMatchObject({ id: 'g1', status: 'repairing' })
    expect(state?.reviewLoop?.groups[0]?.rounds[0]?.receipts.map((r) => r.status)).toEqual([
      'findings',
      'pass'
    ])
  })

  it('skips the repair when every reviewer passes', async () => {
    const runner = await importRunner()
    scriptReviewerOutput([verdictLine('pass'), verdictLine('pass')])
    const chain = runner.restoreCompiledLegacyChain({
      session,
      chainId: 'chn_pass',
      auto: true,
      steps: reviewSteps(2)
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    // Two reviewers ran; the repair never launched and the chain finished.
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(2)
    expect(runner.getSessionChain(chain!.id)?.reviewLoop?.groups[0]).toMatchObject({
      status: 'passed'
    })
  })

  it('parks the chain instead of repairing past the round limit', async () => {
    const runner = await importRunner()
    scriptReviewerOutput([verdictLine('findings', [FINDING]), verdictLine('pass')])
    const chain = runner.restoreCompiledLegacyChain({
      session,
      chainId: 'chn_limit',
      auto: true,
      steps: reviewSteps(1)
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(2)
    expect(runner.getSessionChain(chain!.id)).toMatchObject({
      state: 'ready',
      error: 'Review findings remain unresolved at the configured round limit.'
    })
  })

  it('never reads a missing or malformed verdict as a pass', async () => {
    const runner = await importRunner()
    scriptReviewerOutput(['Looks good to me, shipping it.', verdictLine('pass')])
    const chain = runner.restoreCompiledLegacyChain({
      session,
      chainId: 'chn_crashed',
      auto: true,
      steps: reviewSteps(2)
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(2)
    expect(runner.getSessionChain(chain!.id)).toMatchObject({
      state: 'ready',
      error: 'A selected reviewer did not return a valid verdict.'
    })
  })
})
