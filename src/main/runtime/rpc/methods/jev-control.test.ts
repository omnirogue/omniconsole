import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_CONTROL_METHODS } from '../../../../shared/jev-control'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcContext } from '../core'
import { JEV_CONTROL_RPC_METHODS } from './jev-control'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('../../../structured-decisions/decision-runtime', () => ({
  getStructuredDecisionRuntime: lookup
}))

const input = { recipeId: 'support_triage', state: { message: 'Fictional: my parcel is late.' } }

function harness(effective: 'on' | 'off') {
  const status = vi.fn().mockResolvedValue({ effective })
  const request = vi.fn().mockResolvedValue({ storage: { status: 'saved' } })
  lookup.mockReturnValue({ jev: { status }, request })
  const method = JEV_CONTROL_RPC_METHODS.find(({ name }) => name === JEV_CONTROL_METHODS.request)!
  const invoke = (params: unknown) =>
    method.handler(method.params!.parse(params), {
      runtime: {} as OrcaRuntimeService
    } as RpcContext)
  return { status, request, invoke, params: method.params! }
}

beforeEach(() => lookup.mockReset())

describe('jev.request RPC', () => {
  it.each([
    ['off', 'on', true],
    ['request', 'off', true],
    ['on', 'off', true],
    ['auto', 'on', false],
    ['request', 'on', false]
  ] as const)(
    'records requested %s control on an %s host through the runtime',
    async (control, effective, disabled) => {
      const h = harness(effective)
      await expect(h.invoke({ input, control })).resolves.toEqual({ storage: { status: 'saved' } })
      expect(h.request).toHaveBeenCalledExactlyOnceWith(input, { disabled, control })
    }
  )

  it('accepts the six fixed recipes and refuses actions, keys and arbitrary prompts', () => {
    const { params } = harness('on')
    expect(params.safeParse({ input }).success).toBe(true)
    for (const invalid of [
      { input, apiKey: 'caller-key' },
      { input: { ...input, actions: ['reply'] } },
      { input: { recipeId: 'arbitrary_prompt', state: { task: 'x' } } },
      { input: { ...input, state: { ...input.state, hidden: 'extra' } } }
    ]) {
      expect(params.safeParse(invalid).success).toBe(false)
    }
  })
})
