import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationRun,
  AutomationRunOptions
} from '../../shared/automations-types'
import type { AutomationStructuredOutput } from '../../shared/automation-structured-output'
import { applyAutomationRunProviderSessionResult } from '../../shared/automation-run-provider-session'
import { AutomationService } from './service'

const resolveTarget = vi.hoisted(() => vi.fn())
vi.mock('./run-target-resolution', () => ({ resolveAutomationRunTarget: resolveTarget }))

const configurations: AutomationStructuredOutput[] = [
  { provider: 'typesafe', contract: 'classification.v1' },
  {
    provider: 'typesafe',
    contract: 'advertising.v1',
    advertising: { company: 'betacorp', accountId: 'act_123456789' }
  }
]

function harness(structuredOutput?: AutomationStructuredOutput) {
  const automation: Automation = {
    id: 'automation-1',
    name: 'Structured output fixture',
    prompt: 'Report the observed results.',
    precheck: null,
    agentId: 'codex',
    projectId: 'project-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    structuredOutput,
    enabled: false,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    workspaceId: 'workspace-1',
    createdAt: 0,
    updatedAt: 0
  }
  const initialRun: AutomationRun = {
    id: 'run-1',
    automationId: automation.id,
    title: 'Structured output fixture run 1',
    scheduledFor: 0,
    status: 'pending',
    trigger: 'scheduled',
    workspaceId: automation.workspaceId,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0
  }
  let run = initialRun
  const createAutomationRun = vi
    .fn<Store['createAutomationRun']>()
    .mockImplementation((_automation, scheduledFor, trigger, options) => {
      run = {
        ...initialRun,
        scheduledFor,
        trigger: trigger ?? 'scheduled',
        promptOverride: options?.promptOverride ?? null
      }
      return run
    })
  const updateAutomationRun = vi.fn<Store['updateAutomationRun']>().mockImplementation((update) => {
    const { runId: _runId, providerSession: _providerSession, resume: _resume, ...fields } = update
    run = applyAutomationRunProviderSessionResult({ ...run, ...fields }, update)
    return run
  })
  const store = {
    getProfileStorageDirectory: vi.fn(() => '/fixture-profile'),
    listAutomations: vi.fn(() => [automation]),
    listAutomationRuns: vi.fn(() => []),
    createAutomationRun,
    updateAutomationRun,
    recordRepeatedAutomationSkip: vi.fn(() => null),
    getLatestAutomationOccurrence: vi.fn(() => Date.now()),
    advanceAutomationNextRun: vi.fn()
  }
  const service = new AutomationService(store as unknown as Store)
  return { automation, service, store }
}

beforeEach(() => {
  resolveTarget.mockReset().mockReturnValue({ ok: false, error: 'Fixture target is unavailable.' })
})

describe('AutomationService structured-output run admission', () => {
  it('preserves the not-found error before creating a run', async () => {
    const { service, store } = harness()
    store.listAutomations.mockReturnValue([])

    await expect(service.runNow('missing-routine')).rejects.toThrow('Automation not found.')

    expect(store.createAutomationRun).not.toHaveBeenCalled()
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it.each(configurations)(
    'refuses legacy APPLY and every supplied override for $contract before creating a run',
    async (configuration) => {
      const { automation, service, store } = harness(configuration)

      for (const promptOverride of ['APPLY: pause selected ads', 'A different task', '']) {
        await expect(
          service.runNow(automation.id, { promptOverride, titleSuffix: 'apply action' })
        ).rejects.toThrow('Prompt overrides are unavailable for routines with structured decisions')
      }

      expect(store.createAutomationRun).not.toHaveBeenCalled()
      expect(store.updateAutomationRun).not.toHaveBeenCalled()
      expect(resolveTarget).not.toHaveBeenCalled()
    }
  )

  it('uses the current saved setting when a stale Off client submits APPLY', async () => {
    const { automation, service, store } = harness()
    const staleClientOptions = { promptOverride: 'APPLY: previously selected action' }
    automation.structuredOutput = configurations[0]

    await expect(service.runNow(automation.id, staleClientOptions)).rejects.toThrow(
      'Prompt overrides are unavailable'
    )

    expect(store.listAutomations).toHaveBeenCalledOnce()
    expect(store.createAutomationRun).not.toHaveBeenCalled()
  })

  it.each(configurations)(
    'allows ordinary manual runs and title-only options for $contract',
    async (configuration) => {
      const { automation, service, store } = harness(configuration)
      const options: (AutomationRunOptions | undefined)[] = [
        undefined,
        {},
        { titleSuffix: 'review' },
        { promptOverride: undefined, titleSuffix: 'review' }
      ]

      for (const option of options) {
        await expect(service.runNow(automation.id, option)).resolves.toMatchObject({
          automationId: automation.id,
          promptOverride: null
        })
        expect(store.createAutomationRun).toHaveBeenLastCalledWith(
          automation,
          expect.any(Number),
          'manual',
          option
        )
      }

      expect(store.createAutomationRun).toHaveBeenCalledTimes(options.length)
    }
  )

  it('preserves prompt overrides when the saved routine has structured output off', async () => {
    const { automation, service, store } = harness()
    const options = {
      promptOverride: 'APPLY: existing unstructured action',
      titleSuffix: 'apply action'
    }

    const result = await service.runNow(automation.id, options)

    expect(result.promptOverride).toBe(options.promptOverride)
    expect(store.createAutomationRun).toHaveBeenCalledWith(
      automation,
      expect.any(Number),
      'manual',
      options
    )
  })

  it.each(configurations)(
    'leaves scheduled admission unchanged for $contract',
    async (configuration) => {
      const { automation, service, store } = harness(configuration)
      automation.enabled = true

      service.setRendererReady()

      await vi.waitFor(() => expect(store.createAutomationRun).toHaveBeenCalledOnce())
      expect(store.createAutomationRun).toHaveBeenCalledWith(
        automation,
        expect.any(Number),
        undefined,
        undefined
      )
    }
  )
})
