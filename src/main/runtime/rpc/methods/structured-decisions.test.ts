import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcContext } from '../core'
import { STRUCTURED_DECISION_METHODS } from './structured-decisions'

const runtimeLookup = vi.hoisted(() => vi.fn())
const jevTrial = vi.hoisted(() => vi.fn())
vi.mock('../../../structured-decisions/decision-runtime', () => ({
  getStructuredDecisionRuntime: runtimeLookup
}))
vi.mock('../../../structured-decisions/jev-trial-workflow', () => ({
  evaluateJevTrialWorkflow: jevTrial
}))

const owner = { selector: { kind: 'self' } } as const
const run = { automationId: 'routine-1', runId: 'run-1', expectedOwner: owner }
const action = { ...run, decisionId: 'a'.repeat(64) }
const execution = {
  ...action,
  previewId: `act_${'b'.repeat(32)}`,
  expectedRevision: 'c'.repeat(64),
  approved: true
}
type ActionHandler = (params: unknown, assertOwnerCurrent: () => void) => Promise<unknown>

function method(name: string) {
  const target = STRUCTURED_DECISION_METHODS.find((entry) => entry.name === name)
  if (!target?.params) {
    throw new Error(`Missing structured decision method: ${name}`)
  }
  return { ...target, params: target.params }
}

function harness() {
  const showAutomation = vi
    .fn<(_id: string, _owner: unknown) => { executionTargetType: string }>()
    .mockReturnValue({ executionTargetType: 'local' })
  const automationOwnerPrecondition = vi
    .fn<OrcaRuntimeService['automationOwnerPrecondition']>()
    .mockReturnValue(owner)
  const runtime = { showAutomation, automationOwnerPrecondition } as unknown as OrcaRuntimeService
  const classification = vi.fn<() => Promise<unknown>>().mockResolvedValue({ status: 'ready' })
  const advertising = vi.fn<() => Promise<unknown>>().mockResolvedValue({ status: 'ready' })
  const actions = {
    preview: vi.fn<ActionHandler>().mockResolvedValue({ preview: { id: 'preview-1' } }),
    execute: vi.fn<ActionHandler>().mockResolvedValue({ receipt: { status: 'accepted' } }),
    verify: vi.fn<ActionHandler>().mockResolvedValue({ receipt: { status: 'verified' } })
  }
  const status = vi.fn<() => Promise<unknown>>().mockResolvedValue({ enabled: false })
  const disable = vi.fn<() => Promise<unknown>>().mockResolvedValue({ disabled: true })
  const decisions = { status, disable, routines: { classification, advertising, actions } }
  runtimeLookup.mockReturnValue(decisions)
  const invoke = async (name: string, params: unknown) => {
    const target = method(name)
    return await target.handler(target.params.parse(params), { runtime } as RpcContext)
  }
  return {
    runtime,
    showAutomation,
    automationOwnerPrecondition,
    decisions,
    classification,
    advertising,
    actions,
    invoke
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  runtimeLookup.mockReset()
  jevTrial.mockReset()
})

describe('JEV trial RPC boundary', () => {
  const request = {
    recipeId: 'advertising_review',
    state: { copy: 'Draft copy', offer: 'Approved offer' }
  }

  it('accepts only fixed recipe fields and never an action or provider key', () => {
    const schema = method('structuredDecision.jevTrial').params
    expect(schema.safeParse(request).success).toBe(true)
    for (const invalid of [
      { ...request, apiKey: 'renderer-key' },
      { ...request, actions: ['publish'] },
      { ...request, recipeId: 'arbitrary_prompt' },
      { ...request, state: { ...request.state, hidden: 'extra' } },
      { ...request, state: { ...request.state, copy: '' } },
      { ...request, state: { copy: 'x'.repeat(6000), offer: 'x'.repeat(6000) } }
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false)
    }
  })

  it('refuses all remote callers before inference', async () => {
    const target = method('structuredDecision.jevTrial')
    const params = target.params.parse(request)
    const runtime = {} as OrcaRuntimeService
    await expect(
      target.handler(params, { runtime, pairedDeviceId: 'device' } as RpcContext)
    ).rejects.toThrow('desktop runtime')
    await expect(
      target.handler(params, { runtime, clientKind: 'mobile' } as RpcContext)
    ).rejects.toThrow('desktop runtime')
    await expect(
      target.handler(params, { runtime, clientKind: 'runtime' } as RpcContext)
    ).rejects.toThrow('desktop runtime')
    await expect(target.handler(params, { runtime } as RpcContext)).rejects.toThrow(
      'desktop runtime'
    )
    await expect(
      target.handler(params, {
        runtime,
        clientId: 'desktop-renderer',
        clientKind: 'runtime',
        connectionId: 'remote-connection'
      } as RpcContext)
    ).rejects.toThrow('desktop runtime')
    await expect(
      target.handler(params, {
        runtime,
        clientId: 'desktop-renderer',
        clientKind: 'runtime',
        connectionId: 'desktop-renderer:11:1',
        orchestrationCapability: 'worker'
      } as RpcContext)
    ).rejects.toThrow('desktop runtime')
    expect(jevTrial).not.toHaveBeenCalled()
    expect(runtimeLookup).not.toHaveBeenCalled()
    let effective = 'on'
    runtimeLookup.mockReturnValue({ jev: { status: async () => ({ effective }) } })
    jevTrial.mockResolvedValue({ status: 'unavailable', reason: 'no_api_key' })
    const desktop = {
      runtime,
      clientId: 'desktop-renderer',
      clientKind: 'runtime',
      connectionId: 'desktop-renderer:11:1'
    } as RpcContext
    await expect(target.handler(params, desktop)).resolves.toMatchObject({
      status: 'unavailable'
    })
    expect(jevTrial).toHaveBeenCalledExactlyOnceWith('advertising_review', request.state, {
      disabled: false
    })
    // The host switch is read before any call, as `jev request` and rubric evaluations do.
    effective = 'off'
    await target.handler(params, desktop)
    expect(jevTrial).toHaveBeenLastCalledWith('advertising_review', request.state, {
      disabled: true
    })
  })
})

describe('structured decision RPC input boundary', () => {
  it.each([
    ['automation.structured.get', run],
    ['automation.advertising.get', run],
    ['automation.advertising.preview', action],
    ['automation.advertising.execute', execution],
    ['automation.advertising.verify', action]
  ])('accepts only references, never renderer-authored decisions for %s', (name, params) => {
    const schema = method(name as string).params
    expect(schema.safeParse(params).success).toBe(true)
    for (const field of ['envelope', 'result', 'receipt', 'evidence', 'policy', 'apiKey']) {
      expect(schema.safeParse({ ...(params as object), [field]: { trusted: true } }).success).toBe(
        false
      )
    }
  })

  it.each(['automation.structured.get', 'automation.advertising.get'])(
    'bounds identifiers and requires both run references for %s',
    (name) => {
      const schema = method(name).params
      for (const params of [
        { ...run, automationId: '' },
        { ...run, automationId: 'a'.repeat(201) },
        { ...run, runId: '' },
        { ...run, runId: 'r'.repeat(201) },
        { ...run, automationId: undefined },
        { ...run, runId: undefined }
      ]) {
        expect(schema.safeParse(params).success).toBe(false)
      }
    }
  )

  it.each(['preview', 'execute', 'verify'])(
    'requires an explicit owner and exact decision ID for %s',
    (verb) => {
      const schema = method(`automation.advertising.${verb}`).params
      const params = verb === 'execute' ? execution : action
      expect(schema.safeParse({ ...params, expectedOwner: undefined }).success).toBe(false)
      for (const decisionId of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'untrusted']) {
        expect(schema.safeParse({ ...params, decisionId }).success).toBe(false)
      }
      expect(
        schema.safeParse({
          ...params,
          expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-1' } }
        }).success
      ).toBe(false)
    }
  )

  it('requires explicit approval of the exact preview and revision', () => {
    const schema = method('automation.advertising.execute').params
    for (const approved of [undefined, false, 1, 'true', null]) {
      expect(schema.safeParse({ ...execution, approved }).success).toBe(false)
    }
    for (const previewId of [
      undefined,
      'preview-1',
      `act_${'b'.repeat(31)}`,
      `act_${'B'.repeat(32)}`
    ]) {
      expect(schema.safeParse({ ...execution, previewId }).success).toBe(false)
    }
    for (const expectedRevision of [undefined, 'current', 'c'.repeat(63), 'C'.repeat(64)]) {
      expect(schema.safeParse({ ...execution, expectedRevision }).success).toBe(false)
    }
  })

  it('rejects malformed input before runtime lookup or action execution', async () => {
    const { invoke, showAutomation, actions } = harness()
    await expect(
      invoke('automation.advertising.execute', { ...execution, approved: false })
    ).rejects.toBeTruthy()
    expect(showAutomation).not.toHaveBeenCalled()
    expect(runtimeLookup).not.toHaveBeenCalled()
    expect(actions.execute).not.toHaveBeenCalled()
  })
})

describe('structured decision RPC ownership and execution-host isolation', () => {
  it.each([
    ['automation.structured.get', run],
    ['automation.advertising.get', run],
    ['automation.advertising.preview', action],
    ['automation.advertising.execute', execution],
    ['automation.advertising.verify', action]
  ])('checks the captured owner before evaluating %s', async (name, params) => {
    const { invoke, showAutomation } = harness()
    showAutomation.mockImplementation(() => {
      throw new Error('Owner changed')
    })
    await expect(invoke(name as string, params)).rejects.toThrow('Owner changed')
    expect(showAutomation).toHaveBeenCalledWith(run.automationId, owner)
    expect(runtimeLookup).not.toHaveBeenCalled()
  })

  it.each(['ssh', 'remote', 'unknown'])(
    'does not substitute local evaluation or actions for a %s execution target',
    async (target) => {
      const { invoke, showAutomation, actions, advertising, classification } = harness()
      showAutomation.mockReturnValue({ executionTargetType: target })
      for (const [name, params] of [
        ['automation.structured.get', run],
        ['automation.advertising.get', run],
        ['automation.advertising.preview', action],
        ['automation.advertising.execute', execution],
        ['automation.advertising.verify', action]
      ] as const) {
        await expect(invoke(name, params)).rejects.toThrow('routine execution host')
      }
      expect(runtimeLookup).not.toHaveBeenCalled()
      expect(advertising).not.toHaveBeenCalled()
      expect(classification).not.toHaveBeenCalled()
      for (const handler of Object.values(actions)) {
        expect(handler).not.toHaveBeenCalled()
      }
    }
  )

  it.each([
    ['SSH', { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 1 } }],
    ['orphan', { selector: { kind: 'orphan' } }],
    ['missing', null]
  ] as const)(
    'rejects a stored local row with a %s authoritative owner before runtime lookup',
    async (_label, projectedOwner) => {
      const { invoke, automationOwnerPrecondition, actions, advertising, classification } =
        harness()
      automationOwnerPrecondition.mockReturnValue(projectedOwner)
      for (const [name, params] of [
        ['automation.structured.get', run],
        ['automation.advertising.get', run],
        ['automation.advertising.preview', action],
        ['automation.advertising.execute', execution],
        ['automation.advertising.verify', action]
      ] as const) {
        await expect(invoke(name, params)).rejects.toThrow('routine execution host')
      }
      expect(automationOwnerPrecondition).toHaveBeenCalledWith(run.automationId)
      expect(runtimeLookup).not.toHaveBeenCalled()
      expect(advertising).not.toHaveBeenCalled()
      expect(classification).not.toHaveBeenCalled()
      for (const handler of Object.values(actions)) {
        expect(handler).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['preview', 'execute', 'verify'] as const)(
    'provides %s with a live owner recheck before a post-await side effect',
    async (verb) => {
      const { invoke, showAutomation, actions } = harness()
      const pending = deferred()
      const sideEffect = vi.fn()
      actions[verb].mockImplementation(async (_params, assertOwnerCurrent) => {
        await pending.promise
        assertOwnerCurrent()
        sideEffect()
        return { receipt: { status: 'accepted' } }
      })
      const params = verb === 'execute' ? execution : action
      const request = invoke(`automation.advertising.${verb}`, params)
      expect(actions[verb]).toHaveBeenCalledWith(params, expect.any(Function))
      showAutomation.mockImplementation(() => {
        throw new Error('Owner changed during request')
      })
      pending.resolve()
      await expect(request).rejects.toThrow('Owner changed during request')
      expect(showAutomation).toHaveBeenCalledTimes(2)
      expect(sideEffect).not.toHaveBeenCalled()
    }
  )

  it.each(['preview', 'execute', 'verify'] as const)(
    'rechecks the authoritative owner before %s side effects when the row stays local',
    async (verb) => {
      const { invoke, automationOwnerPrecondition, actions } = harness()
      const pending = deferred()
      const sideEffect = vi.fn()
      actions[verb].mockImplementation(async (_params, assertOwnerCurrent) => {
        await pending.promise
        assertOwnerCurrent()
        sideEffect()
        return { receipt: { status: 'accepted' } }
      })
      const params = verb === 'execute' ? execution : action
      const request = invoke(`automation.advertising.${verb}`, params)
      automationOwnerPrecondition.mockReturnValue({ selector: { kind: 'orphan' } })
      pending.resolve()
      await expect(request).rejects.toThrow('routine execution host')
      expect(automationOwnerPrecondition).toHaveBeenCalledTimes(2)
      expect(runtimeLookup).toHaveBeenCalledTimes(1)
      expect(sideEffect).not.toHaveBeenCalled()
    }
  )

  it.each(['structured', 'advertising'] as const)(
    'fences a completed %s result if ownership changed during evaluation',
    async (kind) => {
      const { invoke, showAutomation, classification, advertising } = harness()
      const pending = deferred()
      const evaluate = kind === 'structured' ? classification : advertising
      evaluate.mockImplementation(async () => {
        await pending.promise
        return { status: 'ready' }
      })
      const request = invoke(`automation.${kind}.get`, run)
      expect(evaluate).toHaveBeenCalledWith(run.automationId, run.runId)
      showAutomation.mockImplementation(() => {
        throw new Error('Owner changed during evaluation')
      })
      pending.resolve()
      await expect(request).rejects.toThrow('Owner changed during evaluation')
      expect(showAutomation).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['structured', 'advertising'] as const)(
    'fences a completed %s result if the authoritative owner disappears while the row stays local',
    async (kind) => {
      const { invoke, automationOwnerPrecondition, classification, advertising } = harness()
      const pending = deferred()
      const evaluate = kind === 'structured' ? classification : advertising
      evaluate.mockImplementation(async () => {
        await pending.promise
        return { status: 'ready' }
      })
      const request = invoke(`automation.${kind}.get`, run)
      automationOwnerPrecondition.mockReturnValue(null)
      pending.resolve()
      await expect(request).rejects.toThrow('routine execution host')
      expect(automationOwnerPrecondition).toHaveBeenCalledTimes(2)
      expect(runtimeLookup).toHaveBeenCalledTimes(1)
    }
  )

  it('returns main-owned results without reconstructing an envelope from the request', async () => {
    const { invoke, showAutomation, runtime, advertising, classification } = harness()
    const envelope = { protocol: 'typesafe-advertising.v1', status: 'blocked' }
    const result = { protocol: 'routine-classification.v1', status: 'blocked' }
    advertising.mockResolvedValue(envelope)
    classification.mockResolvedValue(result)
    expect(await invoke('automation.advertising.get', run)).toEqual({ envelope })
    expect(await invoke('automation.structured.get', run)).toEqual({ result })
    expect(runtimeLookup).toHaveBeenCalledWith(runtime)
    expect(showAutomation).toHaveBeenCalledTimes(4)
  })
})

describe('structured decision RPC operations', () => {
  it.each(['status', 'disable'] as const)(
    'keeps %s a payload-free host operation',
    async (name) => {
      const { invoke, decisions, showAutomation, actions } = harness()
      const expected = name === 'status' ? { enabled: false } : { disabled: true }
      expect(await invoke(`structuredDecision.${name}`, {})).toEqual(expected)
      expect(decisions[name]).toHaveBeenCalledExactlyOnceWith()
      expect(showAutomation).not.toHaveBeenCalled()
      for (const handler of Object.values(actions)) {
        expect(handler).not.toHaveBeenCalled()
      }
      for (const params of [{ enabled: true }, { killSwitch: false }, { apiKey: 'untrusted' }]) {
        await expect(invoke(`structuredDecision.${name}`, params)).rejects.toBeTruthy()
      }
      expect(decisions[name]).toHaveBeenCalledTimes(1)
    }
  )

  it('fails closed when the optional capability is unavailable on the selected host', async () => {
    const { invoke, actions } = harness()
    runtimeLookup.mockImplementation(() => {
      throw new Error('Structured decisions unavailable')
    })
    await expect(invoke('automation.advertising.execute', execution)).rejects.toThrow('unavailable')
    expect(actions.execute).not.toHaveBeenCalled()
  })
})
