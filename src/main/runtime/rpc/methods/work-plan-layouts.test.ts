import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { WORK_PLAN_LAYOUTS_RPC } from '../../../../shared/work-plan-layouts'
import { WORK_PLAN_LAYOUTS_METHODS } from './work-plan-layouts'
import type { RpcContext } from '../core'

const stage = { kind: 'agent', template: 'improve' }
const inputs = {
  list: {},
  save: { name: 'Stage', stage },
  rename: { id: 'id', name: 'Name' },
  delete: { id: 'id' }
}
function setup(overrides: Partial<RpcContext> = {}) {
  const runtime = {
    listWorkPlanLayouts: vi.fn(() => []),
    saveWorkPlanLayout: vi.fn(() => []),
    renameWorkPlanLayout: vi.fn(() => []),
    deleteWorkPlanLayout: vi.fn(() => [])
  }
  const context = { runtime, clientId: 'desktop-renderer', ...overrides } as unknown as RpcContext
  function call(key: keyof typeof inputs, input: unknown = inputs[key]) {
    const method = WORK_PLAN_LAYOUTS_METHODS.find(
      (entry) => entry.name === WORK_PLAN_LAYOUTS_RPC[key]
    )!
    return method.handler(method.params!.parse(input), context)
  }
  return { call, runtime }
}

describe('workPlanLayouts RPC', () => {
  it('registers every layout method', () => {
    expect(WORK_PLAN_LAYOUTS_METHODS.map((method) => method.name)).toEqual(
      Object.values(WORK_PLAN_LAYOUTS_RPC)
    )
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(index).toContain("import { WORK_PLAN_LAYOUTS_METHODS } from './work-plan-layouts'")
    expect(index).toContain('...WORK_PLAN_LAYOUTS_METHODS,')
  })
  it('admits authenticated users on all four methods', () => {
    const { call, runtime } = setup()
    for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
      expect(call(key)).toEqual({ layouts: [] })
    }
    expect(runtime.saveWorkPlanLayout).toHaveBeenCalledWith(inputs.save)
    expect(runtime.renameWorkPlanLayout).toHaveBeenCalledWith('id', 'Name')
    expect(runtime.deleteWorkPlanLayout).toHaveBeenCalledWith('id')
  })
  it('admits local readers but requires user identity for writes', () => {
    const { call } = setup({ clientId: undefined })
    expect(call('list')).toEqual({ layouts: [] })
    for (const key of ['save', 'rename', 'delete'] as const) {
      expect(() => call(key)).toThrow('authenticated user')
    }
  })
  it.each([
    { orchestrationCapability: 'worker' },
    { orchestrationCompatibilityEvidence: { agentSessionId: 'worker' } }
  ])('refuses agent assertions before reading or writing', (overrides) => {
    const { call, runtime } = setup(overrides as Partial<RpcContext>)
    for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
      expect(() => call(key)).toThrow('authenticated user')
    }
    for (const method of Object.values(runtime)) {
      expect(method).not.toHaveBeenCalled()
    }
  })
  it('refuses extra fields, malformed stages and missing names', () => {
    const { call, runtime } = setup()
    for (const input of [
      { name: '', stage },
      { name: 'Name', stage: { kind: 'done' } },
      { name: 'Name', stage: { ...stage, n: 100 } },
      { name: 'Name', stage, repo: '/tmp' }
    ]) {
      expect(() => call('save', input)).toThrow()
    }
    expect(() => call('list', { repo: '/tmp' })).toThrow()
    expect(runtime.saveWorkPlanLayout).not.toHaveBeenCalled()
  })
})
