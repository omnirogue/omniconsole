import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  prepareEnv: vi.fn()
}))

vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateSessionSummaryTextFromPrompt: mocks.generate
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepareEnv
}))

import {
  runSessionSummaryRound,
  sessionSummaryPauseReason,
  startSessionSummaries,
  SUMMARY_QUIET_AFTER_MS,
  type SessionSummaryDeps
} from './session-summary-scheduler'
import type { SessionSearchService } from './session-search-service'

const NOW = 1_900_000_000_000
const usage: ProviderRateLimits = {
  provider: 'claude',
  status: 'ok',
  error: null,
  updatedAt: NOW - 60_000,
  session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
  weekly: null
}

let userDataPath: string
let service: {
  summaryCandidates: ReturnType<typeof vi.fn>
  saveModelSummary: ReturnType<typeof vi.fn>
}

function deps(overrides: Partial<SessionSummaryDeps> = {}): SessionSummaryDeps {
  return {
    service: () => service as unknown as SessionSearchService,
    claudeUsage: () => usage,
    agentEnv: () => undefined,
    userDataPath,
    now: () => NOW,
    loadAverage: () => 2,
    appStartedAt: NOW - SUMMARY_QUIET_AFTER_MS - 60_000,
    lastRestoreSweepAt: () => null,
    quietBackgroundRuns: () => true,
    ...overrides
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'session-summary-'))
  service = {
    summaryCandidates: vi.fn(async () => [
      { sessionKey: 'a', prompt: 'transcript a', basisBytes: 7_000 },
      { sessionKey: 'b', prompt: 'transcript b', basisBytes: 8_000 }
    ]),
    saveModelSummary: vi.fn(async () => true)
  }
  mocks.prepareEnv.mockResolvedValue({ ok: true, env: { HOME: '/home/tester' } })
  mocks.generate.mockResolvedValue({ success: true, rawOutput: 'Summary' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('session summaries (quiet background agent runs)', () => {
  it('summarizes on a settled, idle machine with the cheapest model on the prompt it was given', async () => {
    await expect(runSessionSummaryRound(deps())).resolves.toBe(2)
    expect(mocks.generate).toHaveBeenCalledWith(
      'transcript a',
      { agentId: 'claude', model: 'haiku' },
      expect.objectContaining({ kind: 'local', env: { HOME: '/home/tester' } })
    )
  })

  it.each([
    ['the 1-minute load is above 8', { loadAverage: () => 8.5 }, 'load'],
    ['the app started under 10 minutes ago', { appStartedAt: NOW - 9 * 60_000 }, 'app-start'],
    [
      'a restore sweep ran under 10 minutes ago',
      { lastRestoreSweepAt: () => NOW - 60_000 },
      'restore-sweep'
    ]
  ] as const)('skips the round while %s', async (_label, overrides, reason) => {
    expect(sessionSummaryPauseReason(deps(overrides), NOW)).toBe(reason)
    await expect(runSessionSummaryRound(deps(overrides))).resolves.toBe(0)
    expect(service.summaryCandidates).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('stops a round part-way when the machine gets busy', async () => {
    const load = vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(2).mockReturnValue(12)
    await expect(runSessionSummaryRound(deps({ loadAverage: load }))).resolves.toBe(1)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
  })

  it('keeps the earlier behaviour with the kill switch off', async () => {
    const busy = deps({
      quietBackgroundRuns: () => false,
      loadAverage: () => 20,
      appStartedAt: NOW - 60_000,
      lastRestoreSweepAt: () => NOW - 1_000
    })
    expect(sessionSummaryPauseReason(busy, NOW)).toBeNull()
    await expect(runSessionSummaryRound(busy)).resolves.toBe(2)
  })

  it('keeps OMNI_SESSION_SUMMARIES_DISABLED as the hard off switch', async () => {
    vi.useFakeTimers()
    vi.stubEnv('OMNI_SESSION_SUMMARIES_DISABLED', '1')
    try {
      const stop = startSessionSummaries(deps())
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(service.summaryCandidates).not.toHaveBeenCalled()
      stop()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
