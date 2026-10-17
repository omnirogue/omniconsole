import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'

const mockLaunch = vi.fn()
const mockListRuns = vi.fn()
const mockHostId = vi.fn(() => 'local')

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: (...args: unknown[]) => mockLaunch(...args)
}))
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: (...args: unknown[]) => mockListRuns(...args)
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mockHostId()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { launchAutomationAgentSession } from './automation-thread-resume-launch'

const automation = { id: 'auto-1', agentId: 'codex', reuseSession: true } as Automation
const run = { id: 'run-now' } as AutomationRun
const previous = {
  id: 'run-1',
  automationId: 'auto-1',
  workspaceId: 'wt-1',
  status: 'completed',
  createdAt: 1,
  providerSessionId: 'thread-1',
  providerSessionAgent: 'codex',
  providerSessionTranscriptPath: '/homes/acct/sessions/2026/09/19/rollout-thread-1.jsonl'
} as AutomationRun
const launch = { agent: 'codex' as const, worktreeId: 'wt-1', prompt: 'Go' }
const spawned = { tabId: 'tab', paneKey: 'pane', ptyId: 'pty', terminalOwnership: null }

beforeEach(() => {
  mockLaunch.mockReset()
  mockListRuns.mockReset()
  mockHostId.mockReturnValue('local')
})

describe('launchAutomationAgentSession', () => {
  it('resumes the routine thread when its pane is gone and records the outcome', async () => {
    mockListRuns.mockResolvedValue([previous])
    mockLaunch.mockResolvedValue(spawned)
    const launched = await launchAutomationAgentSession({
      automation,
      run,
      worktreeId: 'wt-1',
      launch
    })
    expect(mockLaunch).toHaveBeenCalledWith({
      ...launch,
      resume: {
        providerSession: {
          key: 'session_id',
          id: 'thread-1',
          transcriptPath: '/homes/acct/sessions/2026/09/19/rollout-thread-1.jsonl'
        }
      }
    })
    expect(launched).toEqual({
      result: spawned,
      resume: { requested: 'thread-1', outcome: 'resumed' }
    })
  })

  it.each([
    'thread not found',
    'spawn response timed out',
    'stream subscription failed after spawn',
    'provider teardown could not be confirmed'
  ])(
    'does not send the routine prompt again after an unverified launch error: %s',
    async (message) => {
      mockListRuns.mockResolvedValue([previous])
      const error = new Error(message)
      mockLaunch.mockRejectedValueOnce(error).mockResolvedValueOnce(spawned)
      await expect(
        launchAutomationAgentSession({ automation, run, worktreeId: 'wt-1', launch })
      ).rejects.toBe(error)
      expect(mockLaunch).toHaveBeenCalledTimes(1)
      expect(mockLaunch.mock.calls[0][0].resume.providerSession.id).toBe('thread-1')
    }
  )

  it('records an unavailable resume launch plan without starting a replacement', async () => {
    mockListRuns.mockResolvedValue([previous])
    mockLaunch.mockResolvedValueOnce(null).mockResolvedValueOnce(spawned)
    await expect(
      launchAutomationAgentSession({ automation, run, worktreeId: 'wt-1', launch })
    ).resolves.toEqual({
      result: null,
      resume: { requested: 'thread-1', outcome: 'failed', reason: 'no launch plan' }
    })
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  it('starts fresh with nothing recorded, without session reuse, or off the local host', async () => {
    mockListRuns.mockResolvedValue([])
    mockLaunch.mockResolvedValue(spawned)
    await expect(
      launchAutomationAgentSession({ automation, run, worktreeId: 'wt-1', launch })
    ).resolves.toEqual({ result: spawned, resume: null })
    expect(mockLaunch).toHaveBeenLastCalledWith(launch)

    mockListRuns.mockResolvedValue([previous])
    await expect(
      launchAutomationAgentSession({
        automation: { ...automation, reuseSession: false },
        run,
        worktreeId: 'wt-1',
        launch
      })
    ).resolves.toEqual({ result: spawned, resume: null })
    expect(mockListRuns).toHaveBeenCalledTimes(1)

    mockHostId.mockReturnValue('ssh:host-1')
    const remote = await launchAutomationAgentSession({
      automation,
      run,
      worktreeId: 'wt-1',
      launch
    })
    expect(remote.resume?.outcome).toBe('fresh')
    expect(mockLaunch).toHaveBeenLastCalledWith(launch)
  })
})
