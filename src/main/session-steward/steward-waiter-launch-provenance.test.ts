import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LaunchCause } from '../../shared/launch-cause'
import type { SessionChain } from '../../shared/session-chain-types'
import { reviveWaiter, runtimeWaiterResumeDeps } from './steward-waiter-resume'
import {
  takeLaunchCauseHints,
  _resetLaunchTriggerHintsForTests
} from '../observability/launch-trigger-hints'

vi.mock('../session-manage/session-manage-observe', () => ({
  observeSession: vi.fn(async (row) => ({
    row,
    facts: { verdict: 'exited', pendingSteps: [], queueLength: 0 }
  }))
}))
vi.mock('../session-manage/session-transcript-locate', () => ({
  locateTranscripts: vi.fn(async () => [
    { path: '/private/transcript', providerRoot: '/private/account', defaultRoot: true }
  ]),
  readTranscriptCwd: vi.fn(async () => '/private/workspace')
}))
const chain = {
  id: 'chn_123456789abc',
  sourcePaneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  outcomeSet: { outcomes: [{ conditions: [{ event: { source: 'session' } }] }] }
} as SessionChain
const cause = {
  trigger: 'steward-resume',
  reference: { outcomeChainId: chain.id },
  actor: { kind: 'app' },
  parentPaneKey: chain.sourcePaneKey
}
afterEach(() => {
  _resetLaunchTriggerHintsForTests()
  vi.restoreAllMocks()
})

describe('waiter recovery launch ownership', () => {
  it.each([true, false])(
    'preserves steward ownership through the retained-row=%s resume branch',
    async (retained) => {
      const row = {
        paneKey: chain.sourcePaneKey,
        tabId: chain.sourcePaneKey.split(':')[0],
        title: 'Waiter',
        hostId: 'local',
        folded: false,
        kind: 'terminal',
        worktreeId: 'wt',
        agent: 'claude',
        providerSessionId: 'abc-123',
        resumable: true
      }
      let resumed = false
      let resumeTab: string | undefined
      const runtime = {
        requestSessionFolders: vi.fn(async (request) => {
          if (request.kind === 'listSessions') {
            return resumed ? [{ ...row, paneKey: 'new:1' }] : retained ? [row] : []
          }
          if (request.kind === 'conversationOrganization') {
            return { deleted: false, hidden: false }
          }
          if (request.kind === 'resumeSession') {
            resumed = true
            resumeTab = request.launchTabId
            return { summary: 'Restarted' }
          }
          return {}
        }),
        ensureAgentSession: vi.fn(
          async (_selector: unknown, _caller?: { launchCause?: LaunchCause }) => {
            resumed = true
            return {
              terminal: { handle: 'term_one', paneKey: 'new:1', tabId: 'new' },
              disposition: 'created'
            }
          }
        ),
        getLastAgentHookRowForPane: () => ({ agentType: 'claude' }),
        getReportedProviderSessionsForPane: () => [{ id: 'abc-123' }]
      }
      const deps = runtimeWaiterResumeDeps(runtime as never, '/tmp/profile')
      const result = await reviveWaiter(deps, chain, null)
      expect(result?.kind).toBe('resumed')
      const actual = retained
        ? takeLaunchCauseHints({ tabId: resumeTab, hasLaunchCommand: true }).tabCause
        : runtime.ensureAgentSession.mock.calls[0]?.[1]?.launchCause
      expect(actual).toEqual(cause)
    }
  )
})
