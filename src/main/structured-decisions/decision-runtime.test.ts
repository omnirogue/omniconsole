import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { Automation } from '../../shared/automations-types'
import {
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { RoutineDecisionService } from './routine-decision-service'
import type { TypeSafeProviderOptions } from './typesafe-provider'
import { DECISION_KILL_ENV, decisionConfigurationSchema } from './decision-configuration'
import { isStructuredDecisionAvailable } from './decision-availability'
import {
  getStructuredDecisionRuntime,
  installStructuredDecisionRuntime,
  type StructuredDecisionRuntime
} from './decision-runtime'
import {
  installOrchestrationShadowObserver,
  observeOrchestrationToolAction
} from './orchestration-shadow'
import { jevCallLedger } from './jev-ledger'

type RoutineOptions = ConstructorParameters<typeof RoutineDecisionService>[0]
type HookListener = (event: AgentHookEventPayload) => void
const mocks = vi.hoisted(() => ({
  credential: vi.fn<() => Promise<string | undefined>>(),
  evaluate: vi.fn<StructuredDecisionProvider['evaluate']>(),
  providerCreated: vi.fn<(options: TypeSafeProviderOptions) => void>(),
  routineCreated: vi.fn<(options: RoutineOptions) => void>(),
  writeRecord: vi.fn<() => Promise<void>>(),
  subscribe: vi.fn<(listener: HookListener) => () => void>()
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { subscribeEnrichedStatus: mocks.subscribe }
}))
vi.mock('./decision-credential', () => ({ resolveTypesafeCredential: mocks.credential }))
vi.mock('./typesafe-provider', () => ({
  TypeSafeDecisionProvider: class {
    readonly id = 'typesafe'
    readonly evaluate = mocks.evaluate
    constructor(options: TypeSafeProviderOptions) {
      mocks.providerCreated(options)
    }
  }
}))
vi.mock('./routine-decision-service', () => ({
  RoutineDecisionService: class {
    readonly dispose = vi.fn()
    constructor(options: RoutineOptions) {
      mocks.routineCreated(options)
    }
  }
}))
vi.mock('./decision-records', () => ({
  DecisionRecords: class {
    readonly write = mocks.writeRecord
  }
}))

const fixtures: string[] = []
const installed: StructuredDecisionRuntime[] = []
const listeners = new Set<HookListener>()
const SECRET = 'PRIVATE_TEST_CREDENTIAL_SENTINEL'
const classification = { provider: 'typesafe', contract: 'classification.v1' } as const
const enabled = {
  version: 1,
  enabled: true,
  killSwitch: false,
  timeoutMs: 5_000,
  capabilities: {
    'routine.structured': { mode: 'live' },
    'advertising.routine': { mode: 'live' },
    'orchestration.tool_action': { mode: 'shadow' }
  },
  routines: {}
}
const result = (): DecisionResult => ({
  provider: 'typesafe',
  model: 'fixture-model',
  answers: {
    decision: {
      type: 'choice',
      choice: 'continue',
      probabilities: { continue: 1, stop: 0 },
      confidence: 1
    }
  },
  usage: { inputTokens: 1, outputTokens: 1 }
})
const request = (routineId = 'routine-1', capability = 'routine.structured'): DecisionRequest => ({
  capability,
  routineId,
  state: { complete: true },
  questions: {
    decision: {
      type: 'choice',
      instructions: 'Choose a result',
      criteria: { continue: 'Continue', stop: 'Stop' }
    }
  }
})
const tool = (overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload => ({
  paneKey: 'pane-1',
  connectionId: null,
  source: 'claude',
  hookEventName: 'PreToolUse',
  launchToken: SECRET,
  payload: { state: 'working', toolName: 'Bash', prompt: SECRET, toolInput: SECRET },
  ...overrides
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
async function harness(configuration: unknown = enabled) {
  const userDataPath = await mkdtemp(join(tmpdir(), 'decision-runtime-'))
  fixtures.push(userDataPath)
  const configurationPath = join(userDataPath, 'structured-decisions.json')
  if (configuration !== null) {
    await writeFile(configurationPath, JSON.stringify(configuration))
  }
  const listAutomations = vi.fn(
    () =>
      [
        {
          id: 'routine-1',
          structuredOutput: classification,
          executionTargetType: 'local',
          executionTargetId: 'local'
        }
      ] as Automation[]
  )
  const automationChangeSelector = vi.fn<Store['automationChangeSelector']>().mockReturnValue(null)
  const automationOwnerPrecondition = vi
    .fn<Store['automationOwnerPrecondition']>()
    .mockReturnValue({ selector: { kind: 'self' } })
  const store = {
    listAutomations,
    automationChangeSelector,
    automationOwnerPrecondition
  } as unknown as Store
  const notifyAutomationsChanged = vi.fn()
  const host = { notifyAutomationsChanged } as unknown as OrcaRuntimeService
  expect(isStructuredDecisionAvailable(host)).toBe(false)
  const runtime = installStructuredDecisionRuntime(host, { userDataPath, store })
  installed.push(runtime)
  return {
    runtime,
    host,
    store,
    userDataPath,
    configurationPath,
    listAutomations,
    automationChangeSelector,
    automationOwnerPrecondition,
    notifyAutomationsChanged
  }
}
function emitTool(event = tool()): void {
  for (const listener of listeners) {
    listener(event)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv(DECISION_KILL_ENV, '0')
  mocks.credential.mockReset().mockResolvedValue(SECRET)
  mocks.evaluate.mockReset().mockResolvedValue(result())
  mocks.writeRecord.mockReset().mockResolvedValue(undefined)
  mocks.subscribe.mockImplementation((listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  })
})
afterEach(async () => {
  installed
    .splice(0)
    .toReversed()
    .forEach((runtime) => runtime.dispose())
  installOrchestrationShadowObserver(null)
  listeners.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('structured decision runtime lifetime', () => {
  it('requires installation and keeps runtime lookups isolated by host identity', async () => {
    expect(() => getStructuredDecisionRuntime({} as OrcaRuntimeService)).toThrow()
    const first = await harness()
    const second = await harness()
    expect(getStructuredDecisionRuntime(first.host)).toBe(first.runtime)
    expect(getStructuredDecisionRuntime(second.host)).toBe(second.runtime)
    expect(first.runtime).not.toBe(second.runtime)
    expect(isStructuredDecisionAvailable(first.host)).toBe(true)
    expect(isStructuredDecisionAvailable(second.host)).toBe(true)
    first.runtime.dispose()
    expect(isStructuredDecisionAvailable(first.host)).toBe(false)
    expect(isStructuredDecisionAvailable(second.host)).toBe(true)
    expect(getStructuredDecisionRuntime(second.host)).toBe(second.runtime)
  })

  it('disposes a replaced installation and admits tool observations only to the replacement', async () => {
    const { host, runtime: previous, userDataPath, store } = await harness()
    const disposeService = vi.spyOn(previous.service, 'dispose')
    const previousShadow = vi.spyOn(previous.service, 'observeShadow').mockImplementation(() => {})
    const started = deferred<AbortSignal>()
    const pending = deferred<DecisionResult>()
    mocks.evaluate.mockImplementation((_request, { signal }) => {
      started.resolve(signal)
      return pending.promise
    })
    const evaluating = previous.service.evaluate(request())
    const signal = await started.promise
    emitTool()
    const replacement = installStructuredDecisionRuntime(host, { userDataPath, store })
    installed.push(replacement)
    const replacementShadow = vi
      .spyOn(replacement.service, 'observeShadow')
      .mockImplementation(() => {})
    previous.dispose()
    expect(getStructuredDecisionRuntime(host)).toBe(replacement)
    expect(isStructuredDecisionAvailable(host)).toBe(true)
    expect(previous.routines.dispose).toHaveBeenCalledTimes(1)
    expect(disposeService).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true)
    await expect(evaluating).resolves.toEqual({ status: 'disabled', reason: 'disposed' })
    pending.resolve(result())
    expect(listeners.size).toBe(1)
    emitTool()
    await Promise.resolve()
    expect(previousShadow).not.toHaveBeenCalled()
    expect(replacementShadow).toHaveBeenCalledTimes(1)
    await expect(previous.service.evaluate(request())).resolves.toEqual({
      status: 'disabled',
      reason: 'disposed'
    })
  })

  it('disposes only once and removes lookup, availability, hook and shadow registrations', async () => {
    const { runtime, host } = await harness()
    const observe = vi.spyOn(runtime.service, 'observeShadow').mockImplementation(() => {})
    const disposeService = vi.spyOn(runtime.service, 'dispose')
    runtime.dispose()
    runtime.dispose()
    expect(() => getStructuredDecisionRuntime(host)).toThrow()
    expect(isStructuredDecisionAvailable(host)).toBe(false)
    expect(listeners.size).toBe(0)
    expect(runtime.routines.dispose).toHaveBeenCalledTimes(1)
    expect(disposeService).toHaveBeenCalledTimes(1)
    emitTool()
    observeOrchestrationToolAction(tool())
    await Promise.resolve()
    expect(observe).not.toHaveBeenCalled()
  })

  it('leaves a failed replacement unavailable instead of publishing its disposed predecessor', async () => {
    const { runtime, host, userDataPath, store } = await harness()
    mocks.providerCreated.mockImplementationOnce(() => {
      throw new Error('fixture installation failed')
    })
    expect(() => installStructuredDecisionRuntime(host, { userDataPath, store })).toThrow(
      'fixture installation failed'
    )
    expect(isStructuredDecisionAvailable(host)).toBe(false)
    expect(() => getStructuredDecisionRuntime(host)).toThrow()
    expect(runtime.routines.dispose).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})

describe('persisted routine opt-in', () => {
  it('enables only configured routines and rereads persisted settings for each evaluation', async () => {
    const { runtime, listAutomations } = await harness({
      ...enabled,
      routines: { legacy: { mode: 'live' } }
    })
    listAutomations.mockReturnValue([
      { id: 'routine-1', structuredOutput: classification },
      {
        id: 'ads',
        structuredOutput: {
          provider: 'typesafe',
          contract: 'advertising.v1',
          advertising: { company: 'omnirogue', accountId: 'act_123456' }
        }
      },
      { id: 'legacy' }
    ] as Automation[])
    for (const id of ['missing', 'legacy']) {
      await expect(runtime.service.evaluate(request(id))).resolves.toEqual({
        status: 'disabled',
        reason: 'routine_not_enabled'
      })
    }
    expect(mocks.evaluate).not.toHaveBeenCalled()
    await expect(runtime.service.evaluate(request())).resolves.toMatchObject({
      status: 'evaluated',
      mode: 'live'
    })
    await expect(
      runtime.service.evaluate(request('ads', 'advertising.routine'))
    ).resolves.toMatchObject({ status: 'evaluated' })
    expect(mocks.evaluate).toHaveBeenCalledTimes(2)
    listAutomations.mockReturnValue([{ id: 'routine-1' }] as Automation[])
    await expect(runtime.service.evaluate(request())).resolves.toEqual({
      status: 'disabled',
      reason: 'routine_not_enabled'
    })
    expect(mocks.evaluate).toHaveBeenCalledTimes(2)
  })

  it('preserves explicit profile restrictions on a configured routine', async () => {
    const { runtime } = await harness({ ...enabled, routines: { 'routine-1': { mode: 'off' } } })
    await expect(runtime.service.evaluate(request())).resolves.toEqual({
      status: 'disabled',
      reason: 'routine_not_enabled'
    })
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })
})

describe.each(['routine.structured', 'advertising.routine'])(
  'routine execution host for %s',
  (capability) => {
    it.each([
      { selector: { kind: 'ssh', targetId: 'host-1', targetGeneration: 2 } },
      { selector: { kind: 'orphan' } },
      null
    ] as const)(
      'refuses inference for a local-stored routine projected to owner %j',
      async (owner) => {
        const { runtime, automationOwnerPrecondition } = await harness()
        automationOwnerPrecondition.mockReturnValue(owner)

        await expect(runtime.service.evaluate(request('routine-1', capability))).resolves.toEqual({
          status: 'disabled',
          reason: 'routine_not_enabled'
        })
        expect(automationOwnerPrecondition).toHaveBeenCalledWith('routine-1')
        expect(mocks.evaluate).not.toHaveBeenCalled()
      }
    )

    it('fails closed when the owning host projection cannot be read', async () => {
      const { runtime, automationOwnerPrecondition } = await harness()
      automationOwnerPrecondition.mockImplementation(() => {
        throw new Error('owner unavailable')
      })

      await expect(runtime.service.evaluate(request('routine-1', capability))).resolves.toEqual({
        status: 'disabled',
        reason: 'routine_not_enabled'
      })
      expect(mocks.evaluate).not.toHaveBeenCalled()
    })

    it.each(['retry', 'result'] as const)(
      'rechecks ownership before accepting provider %s work',
      async (phase) => {
        const { runtime, automationOwnerPrecondition } = await harness()
        mocks.evaluate.mockImplementationOnce(async () => {
          automationOwnerPrecondition.mockReturnValue({
            selector: { kind: 'ssh', targetId: 'repinned-host', targetGeneration: 3 }
          })
          if (phase === 'retry') {
            throw new DecisionProviderError('overloaded', true, 0)
          }
          return result()
        })

        await expect(runtime.service.evaluate(request('routine-1', capability))).resolves.toEqual({
          status: 'disabled',
          reason: 'routine_not_enabled'
        })
        expect(mocks.evaluate).toHaveBeenCalledTimes(1)
        expect(runtime.service.telemetry.snapshot()).toEqual([
          expect.objectContaining({
            status: 'disabled',
            reason: 'routine_not_enabled',
            attempts: 1
          })
        ])
      }
    )
  }
)

describe('runtime status and disable', () => {
  it('keeps burst telemetry in memory without syncing a file for every tool observation', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { runtime } = await harness()
    const event = {
      timestamp: Date.now(),
      capability: 'orchestration.tool_action',
      mode: 'shadow' as const,
      status: 'disabled' as const,
      reason: 'disabled' as const,
      elapsedMs: 0,
      attempts: 0
    }
    runtime.service.telemetry.record(event)
    runtime.service.telemetry.record(event)
    runtime.service.telemetry.record(event)
    await vi.waitFor(() => expect(mocks.writeRecord).toHaveBeenCalledTimes(1))
    expect(runtime.service.telemetry.snapshot()).toHaveLength(3)
    clock.mockReturnValue(1101)
    runtime.service.telemetry.record(event)
    await vi.waitFor(() => expect(mocks.writeRecord).toHaveBeenCalledTimes(2))
    expect(runtime.service.telemetry.snapshot()).toHaveLength(4)
  })

  it('reports credential availability without returning or persisting its value', async () => {
    const { runtime, configurationPath } = await harness()
    await runtime.service.evaluate(request())
    const status = await runtime.status()
    expect(status).toMatchObject({
      available: true,
      configurationPath,
      credentialConfigured: true,
      configuration: { enabled: true, valid: true },
      semantics: {
        orchestration: 'shadow_only',
        structuredPassCreatesReceipt: false,
        shadowAddsInferenceCost: true
      }
    })
    expect(status.telemetry).toHaveLength(1)
    expect(status.measurement.service).toMatchObject({ admitted: 1, started: 1, completed: 1 })
    expect(status.measurement.observer).toMatchObject({
      scope: 'process_since_start',
      counters: { sourceEntriesInspected: expect.any(Number) }
    })
    expect(mocks.providerCreated.mock.calls[0]![0].resolveApiKey).toBe(mocks.credential)
    expect(JSON.stringify(status)).not.toContain(SECRET)
    expect(JSON.stringify(mocks.writeRecord.mock.calls)).not.toContain(SECRET)
    mocks.credential.mockResolvedValue(undefined)
    expect((await runtime.status()).credentialConfigured).toBe(false)
  })

  it('aborts outstanding inference and atomically saves strict disabled configuration', async () => {
    const { runtime, configurationPath, userDataPath } = await harness({
      ...enabled,
      model: 'fixture-model'
    })
    const started = deferred<AbortSignal>()
    const pending = deferred<DecisionResult>()
    mocks.evaluate.mockImplementation((_request, { signal }) => {
      started.resolve(signal)
      return pending.promise
    })
    const evaluating = runtime.service.evaluate(request())
    const signal = await started.promise
    const disabling = runtime.disable()
    expect(signal.aborted).toBe(true)
    await expect(disabling).resolves.toEqual({ disabled: true })
    await expect(evaluating).resolves.toEqual({ status: 'disabled', reason: 'disabled' })
    pending.resolve(result())
    const saved: unknown = JSON.parse(await readFile(configurationPath, 'utf8'))
    expect(decisionConfigurationSchema.safeParse(saved).success).toBe(true)
    expect(saved).toEqual({ ...enabled, model: 'fixture-model', enabled: false, killSwitch: true })
    expect(saved).not.toHaveProperty('valid')
    expect(await readdir(userDataPath)).toEqual(['structured-decisions.json'])
    if (process.platform !== 'win32') {
      expect((await stat(configurationPath)).mode & 0o777).toBe(0o600)
    }
    expect((await runtime.status()).configuration).toMatchObject({
      valid: true,
      enabled: false,
      killSwitch: true
    })
    await expect(runtime.service.evaluate(request())).resolves.toEqual({
      status: 'disabled',
      reason: 'disabled'
    })
    expect(mocks.evaluate).toHaveBeenCalledTimes(1)
  })

  it.each([null, { ...enabled, apiKey: SECRET }])(
    'can persist a disabled configuration after missing or invalid input: %#',
    async (configuration) => {
      const { runtime, configurationPath } = await harness(configuration)
      await runtime.disable()
      const text = await readFile(configurationPath, 'utf8')
      const saved = decisionConfigurationSchema.parse(JSON.parse(text))
      expect(saved).toMatchObject({
        enabled: false,
        killSwitch: true,
        capabilities: {},
        routines: {}
      })
      expect(text).not.toContain(SECRET)
      expect((await runtime.status()).configuration.valid).toBe(true)
    }
  )
})

describe('agent JEV request records', () => {
  it('keeps every request result as a private jev-request record and reports write failures', async () => {
    const { runtime } = await harness()
    const input = { recipeId: 'lead_fit', state: { lead: 'Fictional', criteria: 'Fit' } } as const
    const saved = await runtime.request(input, { disabled: false, control: 'off' })
    const key = `jev-request:${saved.request_id}`
    expect(saved).toMatchObject({
      schema_version: 'jev-request-record/1',
      result: { status: 'unavailable', reason: 'disabled' },
      storage: { status: 'saved', key, ledger: 'saved' }
    })
    expect((mocks.writeRecord.mock.calls as unknown[][]).at(-1)).toEqual([
      'result',
      key,
      saved,
      expect.anything()
    ])
    expect(mocks.evaluate).not.toHaveBeenCalled()

    mocks.writeRecord.mockRejectedValueOnce(new Error('read-only profile'))
    const failed = await runtime.request(input, { disabled: true, control: 'request' })
    expect(failed.storage).toEqual({
      status: 'failed',
      key: `jev-request:${failed.request_id}`,
      reason: 'record_write_failed',
      ledger: 'saved'
    })
    expect(failed.control).toEqual({ requested: 'request', effective: 'off' })
  })

  it('writes hash-only ledger rows, accepts a label for them and lists both', async () => {
    const { runtime, userDataPath } = await harness()
    const input = { recipeId: 'support_triage', state: { message: SECRET } } as const
    const saved = await runtime.request(input, { disabled: false, control: 'off' })
    const key = `jev-request:${saved.request_id}`
    const ledgerFile = join(userDataPath, 'structured-decisions', 'jev-ledger', 'calls.jsonl')
    const text = await readFile(ledgerFile, 'utf8')
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text)).toMatchObject({
      schema: 'jev-call/1',
      record_key: key,
      caller: 'jev.request',
      transport: 'advisory',
      deadline_ms: 5000,
      ref: 'support_triage@1',
      status: 'unavailable',
      provider_status: 'not_called',
      reason: 'disabled',
      calls: 0
    })
    await expect(
      runtime.recordOutcome({
        record_key: key,
        outcome: {
          label: 'billing',
          evidence_level: 'ground_truth',
          source: 'human',
          labeler: 'session:support-lead-review',
          blind: false
        }
      })
    ).resolves.toMatchObject({ outcome: { schema: 'jev-outcome/1', question_id: null } })
    const listed = await runtime.listRecords({})
    expect(listed.records).toEqual([expect.objectContaining({ record_key: key, outcomes: 1 })])
    runtime.dispose()
    expect(jevCallLedger()).toBeUndefined()
  })
})

describe('main-owned observation and notification wiring', () => {
  it('projects current tool hooks into non-authoritative shadow input and filters replay', async () => {
    const { runtime } = await harness()
    const observe = vi.spyOn(runtime.service, 'observeShadow').mockImplementation(() => {})
    const evaluate = vi.spyOn(runtime.service, 'evaluate')
    emitTool(tool({ restoredUnconfirmed: true }))
    emitTool(tool({ isReplay: true }))
    emitTool(tool({ providerSessionOnly: true }))
    emitTool()
    expect(observe).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        capability: 'orchestration.tool_action',
        state: expect.objectContaining({ knownTool: 'bash', argumentsIncluded: false })
      }),
      {
        comparison: { classification: 'execute' },
        measurement: {
          baselineSource: 'tool_name_classifier',
          eventReference: expect.stringMatching(/^[a-f0-9]{64}$/),
          eventFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          evidenceScope: 'structural_metadata',
          projectionVersion: 'orchestration-structural-v2'
        }
      }
    )
    expect(JSON.stringify(observe.mock.calls)).not.toContain(SECRET)
    expect(evaluate).not.toHaveBeenCalled()
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })

  it.each([null, { kind: 'self' }, { kind: 'ssh', targetId: 'host-1' }] as const)(
    'binds routine notifications to the owning selector %j',
    async (selector) => {
      const { runtime, store, notifyAutomationsChanged, automationChangeSelector } = await harness()
      automationChangeSelector.mockReturnValue(selector)
      const options = mocks.routineCreated.mock.calls[0]![0]
      expect(options.store).toBe(store)
      expect(options.service).toBe(runtime.service)
      options.notify('routine-1')
      expect(automationChangeSelector).toHaveBeenCalledWith('routine-1')
      expect(notifyAutomationsChanged).toHaveBeenCalledExactlyOnceWith({
        reason: 'run',
        ...(selector ? { selector } : {})
      })
    }
  )
})
