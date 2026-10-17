import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { applyAutomationRunProviderSessionResult } from '../../shared/automation-run-provider-session'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunOutputSnapshot,
  AutomationRunUsage
} from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import type { readAutomationFinalTurn } from './automation-final-turn'
import type { AutomationOutputBinding } from './automation-output-binding'
import {
  createAutomationFinalOutputResolver,
  type ResolveAutomationFinalOutput
} from './automation-output-provenance'
import { collectAutomationRunUsage } from './run-usage-collection'
import { AutomationService } from './service'

vi.mock('./run-target-resolution', () => ({ resolveAutomationRunTarget: vi.fn() }))
vi.mock('./automation-final-turn', () => ({ readAutomationFinalTurn: vi.fn() }))
vi.mock('./run-usage-collection', () => ({ collectAutomationRunUsage: vi.fn() }))

const startedAt = 1_000
const completedAt = 3_000
const nativeContent = '  Native final answer.\nEvidence: verified.\n'
const proven: AutomationRunOutputSnapshot = {
  format: 'plain_text',
  content: nativeContent,
  capturedAt: completedAt + 3,
  truncated: false,
  provenance: 'assistant_message'
}
const usage: AutomationRunUsage = {
  status: 'known',
  provider: 'claude',
  model: null,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningOutputTokens: null,
  totalTokens: 3,
  estimatedCostUsd: null,
  estimatedCostSource: null,
  providerSessionId: 'session-1',
  attribution: 'provider_session_time_window',
  collectedAt: completedAt,
  unavailableReason: null,
  unavailableMessage: null
}
const services: AutomationService[] = []

function harness(
  resolveFinalOutput: ResolveAutomationFinalOutput = vi.fn(() => null),
  optedIn = true,
  runCount = 1
) {
  const automation: Automation = {
    id: 'automation-1',
    name: 'Final output wait fixture',
    prompt: 'Report observed results.',
    precheck: null,
    agentId: 'claude',
    projectId: 'project-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    baseBranch: null,
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    ...(optedIn
      ? { structuredOutput: { provider: 'typesafe', contract: 'classification.v1' } as const }
      : {}),
    enabled: false,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    workspaceId: 'workspace-1',
    createdAt: 0,
    updatedAt: 0
  }
  let run: AutomationRun = {
    id: 'run-1',
    automationId: automation.id,
    title: 'Final output wait fixture run 1',
    scheduledFor: startedAt,
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: automation.workspaceId,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'terminal-1',
    terminalPaneKey: 'pane-1',
    terminalPtyId: 'pty-1',
    providerSessionAgent: 'claude',
    providerSessionId: 'session-1',
    outputSnapshot: null,
    precheckResult: null,
    usage,
    error: null,
    startedAt,
    dispatchedAt: startedAt,
    createdAt: startedAt
  }
  const runs = new Map<string, AutomationRun>(
    Array.from({ length: runCount }, (_, index) => {
      const id = `run-${index + 1}`
      return [id, { ...run, id }] as const
    })
  )
  const updateAutomationRun = vi.fn<Store['updateAutomationRun']>().mockImplementation((update) => {
    const { runId: _runId, providerSession: _providerSession, resume: _resume, ...fields } = update
    run = applyAutomationRunProviderSessionResult({ ...runs.get(update.runId)!, ...fields }, update)
    runs.set(run.id, run)
    automation.lastRunAt = Date.now()
    automation.updatedAt = Date.now()
    return run
  })
  const store = {
    getProfileStorageDirectory: vi.fn(() => '/fixture-profile'),
    listAutomations: vi.fn(() => [automation]),
    listAutomationRuns: vi.fn(() => [...runs.values()]),
    automationOwnerPrecondition: vi
      .fn<Store['automationOwnerPrecondition']>()
      .mockReturnValue({ selector: { kind: 'self' } }),
    automationChangeSelector: vi.fn(() => ({ kind: 'self' as const })),
    updateAutomationRun
  }
  const publishedSnapshots: (AutomationRunOutputSnapshot | null)[] = []
  const publish = vi.fn(() => {
    publishedSnapshots.push(run.outputSnapshot)
  })
  const service = new AutomationService(store as unknown as Store, {
    resolveFinalOutput,
    onAutomationsChanged: publish
  })
  services.push(service)
  return {
    automation,
    service,
    store,
    publish,
    publishedSnapshots,
    readRun: (runId = 'run-1') => runs.get(runId)!
  }
}

function completion(): AutomationDispatchResult {
  return {
    runId: 'run-1',
    status: 'completed',
    outputSnapshot: {
      format: 'plain_text',
      content: 'Renderer capture is not native proof.',
      capturedAt: completedAt,
      truncated: true,
      provenance: 'assistant_message'
    }
  }
}

function nativeResolver() {
  const launchToken = 'fixture-native-launch'
  const binding: AutomationOutputBinding = Object.freeze({
    automationId: 'automation-1',
    runId: 'run-1',
    agent: 'claude',
    workspaceId: 'workspace-1',
    paneKey: 'pane-1',
    terminalHandle: 'terminal-1',
    ptyId: 'pty-1',
    processIncarnation: 'process-1',
    launchTokenHash: createHash('sha256').update(launchToken).digest('hex'),
    startedAt
  })
  const authority: OrchestrationCompatibilityTerminalAuthority = {
    runtimeId: 'runtime-1',
    terminalHandle: binding.terminalHandle,
    ptyId: binding.ptyId,
    processIncarnation: binding.processIncarnation,
    paneKey: binding.paneKey,
    launchTokenHash: binding.launchTokenHash,
    worktreeId: binding.workspaceId,
    hostScope: { kind: 'local', hostId: 'local' }
  }
  const hook: AgentStatusIpcPayload = {
    paneKey: binding.paneKey,
    worktreeId: binding.workspaceId,
    terminalHandle: binding.terminalHandle,
    launchToken,
    connectionId: null,
    state: 'done',
    prompt: 'Routine prompt',
    agentType: 'claude',
    stateStartedAt: completedAt,
    receivedAt: completedAt,
    providerSession: {
      key: 'session_id',
      id: 'session-1',
      transcriptPath: '/fixture/native-transcript.jsonl'
    },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'main-fixture',
      incarnation: 1,
      revision: 2,
      observedAt: completedAt
    }
  }
  const readFinalTurn = vi
    .fn<typeof readAutomationFinalTurn>()
    .mockImplementation(() =>
      Date.now() >= completedAt + 3
        ? { content: nativeContent, completedAt: completedAt + 3 }
        : null
    )
  const readAuthority = vi
    .fn<(_: string) => OrchestrationCompatibilityTerminalAuthority | null>()
    .mockReturnValue(authority)
  const resolve = vi.fn(
    createAutomationFinalOutputResolver(
      () => [hook],
      readFinalTurn,
      () => binding,
      readAuthority,
      () => Date.now()
    )
  )
  return { resolve, readFinalTurn, readAuthority, authority }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(completedAt)
  vi.mocked(collectAutomationRunUsage).mockReset().mockResolvedValue(usage)
})

afterEach(() => {
  for (const service of services.splice(0)) {
    service.stop()
  }
  vi.useRealTimers()
})

describe('AutomationService final output proof wait', () => {
  it('waits for a native final record flushed 3ms after Stop before persisting or publishing', async () => {
    const native = nativeResolver()
    const f = harness(native.resolve)
    const pending = f.service.markDispatchResult(completion())

    expect(native.resolve).toHaveBeenCalledOnce()
    expect(native.readFinalTurn).toHaveReturnedWith(null)
    expect(f.store.updateAutomationRun).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3)
    expect(f.store.updateAutomationRun).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(22)
    await expect(pending).resolves.toMatchObject({ status: 'completed', outputSnapshot: proven })
    expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ reason: 'run', selector: { kind: 'self' } })
    expect(f.publishedSnapshots).toEqual([proven])
    expect(native.readFinalTurn).toHaveBeenLastCalledWith({
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/fixture/native-transcript.jsonl',
      startedAt,
      completedAt: completedAt + 25
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves the ordinary completed result unproven after the bounded 1000ms wait', async () => {
    const readTimes: number[] = []
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockImplementation(() => {
      readTimes.push(Date.now() - completedAt)
      return null
    })
    const f = harness(resolve)
    const result = completion()
    const pending = f.service.markDispatchResult(result)

    await vi.advanceTimersByTimeAsync(999)
    expect(f.store.updateAutomationRun).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    const saved = await pending
    expect(saved.status).toBe('completed')
    expect(saved.outputSnapshot).toEqual({
      format: 'plain_text',
      content: result.outputSnapshot!.content,
      capturedAt: completedAt,
      truncated: true
    })
    expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()
    expect(f.publish).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledTimes(8)
    expect(readTimes).toEqual([0, 25, 75, 175, 375, 775, 1_000, 1_000])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps concurrent proof waits at four and reuses capacity after bounded completion', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve, true, 5)
    const pending = Array.from({ length: 5 }, (_, index) =>
      f.service.markDispatchResult({ ...completion(), runId: `run-${index + 1}` })
    )

    expect(resolve).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(4)
    const overflow = await pending[4]
    expect(overflow.id).toBe('run-5')
    expect(overflow.outputSnapshot?.provenance).toBeUndefined()
    expect(resolve.mock.calls.some(([run]) => run.id === 'run-5')).toBe(false)
    expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)
    const saved = await Promise.all(pending)

    expect(saved.every((run) => run.outputSnapshot?.provenance === undefined)).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(32)
    for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
      expect(resolve.mock.calls.filter(([run]) => run.id === runId)).toHaveLength(8)
    }
    expect(vi.getTimerCount()).toBe(0)

    resolve.mockReturnValue(proven)
    await expect(
      f.service.markDispatchResult({ ...completion(), runId: 'run-5' })
    ).resolves.toMatchObject({ id: 'run-5', outputSnapshot: proven })
    expect(resolve.mock.calls.filter(([run]) => run.id === 'run-5')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows sibling runs to finish proving despite ordinary routine bookkeeping writes', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockImplementation((run) => {
      const readyAt = completedAt + (run.id === 'run-1' ? 3 : 30)
      return Date.now() >= readyAt ? proven : null
    })
    const f = harness(resolve, true, 2)
    const first = f.service.markDispatchResult(completion())
    const second = f.service.markDispatchResult({ ...completion(), runId: 'run-2' })

    await vi.advanceTimersByTimeAsync(25)
    await expect(first).resolves.toMatchObject({ id: 'run-1', outputSnapshot: proven })
    expect(f.readRun('run-2').status).toBe('dispatched')
    expect(f.automation.lastRunAt).toBe(completedAt + 25)
    expect(f.automation.updatedAt).toBe(completedAt + 25)
    expect(f.publish).toHaveBeenCalledOnce()
    f.automation.nextRunAt = completedAt + 60_000

    await vi.advanceTimersByTimeAsync(50)
    await expect(second).resolves.toMatchObject({ id: 'run-2', outputSnapshot: proven })
    expect(f.publishedSnapshots).toEqual([proven, proven])
    expect(f.store.updateAutomationRun).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['routine', 'run', 'owner', 'opt-out'] as const)(
    'does not publish proof if the %s source changes while waiting',
    async (changed) => {
      const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
      const f = harness(resolve)
      const pending = f.service.markDispatchResult(completion())
      await vi.advanceTimersByTimeAsync(3)
      resolve.mockReturnValue(proven)
      if (changed === 'routine') {
        f.automation.prompt = 'A different saved prompt.'
      } else if (changed === 'run') {
        f.readRun().providerSessionId = 'replacement-session'
      } else if (changed === 'owner') {
        f.store.automationOwnerPrecondition.mockReturnValue(null)
      } else {
        delete f.automation.structuredOutput
      }

      await vi.advanceTimersByTimeAsync(22)
      const saved = await pending
      expect(saved.status).toBe('completed')
      expect(saved.outputSnapshot?.provenance).toBeUndefined()
      expect(resolve).toHaveBeenCalledOnce()
      expect(f.publish).toHaveBeenCalledOnce()
      expect(f.publishedSnapshots[0]?.provenance).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('rechecks the source after an immediately successful probe yields back to the service', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(proven)
    const f = harness(resolve)
    const pending = f.service.markDispatchResult(completion())
    f.automation.prompt = 'Changed before the completed write.'

    const saved = await pending

    expect(saved.outputSnapshot?.provenance).toBeUndefined()
    expect(resolve).toHaveBeenCalledOnce()
    expect(f.publishedSnapshots[0]?.provenance).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['source', 'owner', 'stop'] as const)(
    'does not establish proof in the later usage write after %s invalidates the initial wait',
    async (changed) => {
      const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
      const f = harness(resolve)
      f.readRun().usage = null
      let finishUsage!: (value: AutomationRunUsage) => void
      vi.mocked(collectAutomationRunUsage).mockReturnValueOnce(
        new Promise((complete) => {
          finishUsage = complete
        })
      )
      const pending = f.service.markDispatchResult(completion())
      await vi.advanceTimersByTimeAsync(3)
      resolve.mockReturnValue(proven)
      if (changed === 'source') {
        f.automation.prompt = 'Changed while native proof was pending.'
      } else if (changed === 'owner') {
        f.store.automationOwnerPrecondition.mockReturnValue(null)
      } else {
        f.service.stop()
      }

      await vi.advanceTimersByTimeAsync(22)
      expect(collectAutomationRunUsage).toHaveBeenCalledOnce()
      expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()
      expect(f.readRun().usage).toBeNull()
      expect(f.readRun().outputSnapshot?.provenance).toBeUndefined()
      expect(f.publishedSnapshots).toHaveLength(1)

      finishUsage(usage)
      const saved = await pending

      expect(saved.status).toBe('completed')
      expect(saved.usage).toEqual(usage)
      expect(saved.outputSnapshot?.provenance).toBeUndefined()
      expect(f.store.updateAutomationRun).toHaveBeenCalledTimes(2)
      expect(f.store.updateAutomationRun.mock.calls[1][0]).toEqual({
        runId: 'run-1',
        status: 'completed',
        workspaceId: 'workspace-1',
        terminalSessionId: 'terminal-1',
        usage,
        error: null
      })
      expect(f.publishedSnapshots.map((snapshot) => snapshot?.provenance)).toEqual([
        undefined,
        undefined
      ])
      expect(resolve).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('retains already proven output across the later usage-only write without resolving again', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve)
    f.readRun().status = 'completed'
    f.readRun().outputSnapshot = proven
    f.readRun().usage = null

    const saved = await f.service.markDispatchResult(completion())

    expect(saved.outputSnapshot).toEqual(proven)
    expect(saved.usage).toEqual(usage)
    expect(collectAutomationRunUsage).toHaveBeenCalledOnce()
    expect(f.store.updateAutomationRun).toHaveBeenCalledTimes(2)
    expect(f.publishedSnapshots).toEqual([proven, proven])
    expect(resolve).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves Off output unchanged when usage is collected after synchronous completion', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(proven)
    const f = harness(resolve, false)
    f.readRun().usage = null
    const raw: AutomationRunOutputSnapshot = {
      format: 'plain_text',
      content: 'Ordinary terminal capture.',
      capturedAt: completedAt,
      truncated: true
    }

    const pending = f.service.markDispatchResult({
      runId: 'run-1',
      status: 'completed',
      outputSnapshot: raw
    })

    expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()
    expect(f.publishedSnapshots).toEqual([raw])
    const saved = await pending
    expect(saved.outputSnapshot).toEqual(raw)
    expect(saved.usage).toEqual(usage)
    expect(collectAutomationRunUsage).toHaveBeenCalledOnce()
    expect(f.store.updateAutomationRun).toHaveBeenCalledTimes(2)
    expect(f.publishedSnapshots).toEqual([raw, raw])
    expect(resolve).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['missing', 'replaced'] as const)(
    'refuses a late final record after the reused process authority is %s',
    async (state) => {
      const native = nativeResolver()
      const f = harness(native.resolve)
      const pending = f.service.markDispatchResult(completion())
      await vi.advanceTimersByTimeAsync(3)
      native.readAuthority.mockReturnValue(
        state === 'missing'
          ? null
          : { ...native.authority, ptyId: 'new-pty', processIncarnation: 'new-process' }
      )

      await vi.advanceTimersByTimeAsync(997)
      const saved = await pending

      expect(saved.status).toBe('completed')
      expect(saved.outputSnapshot?.provenance).toBeUndefined()
      expect(native.readFinalTurn).toHaveBeenCalledOnce()
      expect(f.publishedSnapshots[0]?.provenance).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['absent', 'raw'] as const)(
    'persists Off completion synchronously with unchanged %s output and no proof reads',
    async (output) => {
      const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(proven)
      const f = harness(resolve, false)
      const result: AutomationDispatchResult = { runId: 'run-1', status: 'completed' }
      if (output === 'raw') {
        result.outputSnapshot = {
          format: 'plain_text',
          content: 'Ordinary terminal capture.',
          capturedAt: completedAt,
          truncated: true
        }
      }

      const pending = f.service.markDispatchResult(result)

      expect(f.store.updateAutomationRun).toHaveBeenCalledExactlyOnceWith(result)
      expect(f.publish).toHaveBeenCalledOnce()
      expect(resolve).not.toHaveBeenCalled()
      expect(f.store.automationOwnerPrecondition).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await expect(pending).resolves.toMatchObject({
        status: 'completed',
        outputSnapshot: result.outputSnapshot ?? null
      })
    }
  )

  it('does not wait or reread proof for an already confirmed completed output', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve)
    f.readRun().status = 'completed'
    f.readRun().outputSnapshot = proven

    const pending = f.service.markDispatchResult({ runId: 'run-1', status: 'completed' })

    expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()
    expect(f.publish).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(pending).resolves.toMatchObject({ outputSnapshot: proven })
  })

  it('does not wait for a non-completed dispatch result', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve)
    const result: AutomationDispatchResult = { runId: 'run-1', status: 'dispatched' }

    const pending = f.service.markDispatchResult(result)

    expect(f.store.updateAutomationRun).toHaveBeenCalledExactlyOnceWith(result)
    expect(f.publish).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(pending).resolves.toMatchObject({ status: 'dispatched' })
  })

  it('cancels pending proof timers on stop and persists only the unproven completion', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve)
    const pending = f.service.markDispatchResult(completion())
    expect(vi.getTimerCount()).toBe(1)
    expect(f.publish).not.toHaveBeenCalled()
    resolve.mockReturnValue(proven)

    f.service.stop()
    const saved = await pending

    expect(saved.status).toBe('completed')
    expect(saved.outputSnapshot?.provenance).toBeUndefined()
    expect(resolve).toHaveBeenCalledOnce()
    expect(f.store.updateAutomationRun).toHaveBeenCalledOnce()
    expect(f.publishedSnapshots[0]?.provenance).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not revive a stopped proof preparation when the service immediately restarts', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve)
    const pending = f.service.markDispatchResult(completion())
    resolve.mockReturnValue(proven)

    f.service.stop()
    f.service.start()
    const saved = await pending

    expect(saved.outputSnapshot?.provenance).toBeUndefined()
    expect(resolve).toHaveBeenCalledOnce()
    expect(f.publishedSnapshots[0]?.provenance).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)

    await expect(f.service.markDispatchResult(completion())).resolves.toMatchObject({
      outputSnapshot: proven
    })
    expect(f.publishedSnapshots[1]).toEqual(proven)
    f.service.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the first native proof when duplicate completion callers share the same wait', async () => {
    const resolve = vi.fn<ResolveAutomationFinalOutput>().mockReturnValue(null)
    const f = harness(resolve)
    const first = f.service.markDispatchResult(completion())
    const secondResult = completion()
    secondResult.outputSnapshot!.content = 'Later renderer capture cannot replace native proof.'
    const second = f.service.markDispatchResult(secondResult)

    expect(resolve).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    expect(f.publish).not.toHaveBeenCalled()
    resolve.mockReturnValue(proven)

    await vi.advanceTimersByTimeAsync(25)
    const saved = await Promise.all([first, second])

    expect(saved.map((run) => run.outputSnapshot)).toEqual([proven, proven])
    expect(f.readRun().outputSnapshot).toEqual(proven)
    expect(f.publishedSnapshots).toEqual([proven, proven])
    expect(f.store.updateAutomationRun).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
