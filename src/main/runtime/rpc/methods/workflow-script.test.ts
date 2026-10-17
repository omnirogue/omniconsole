import { describe, expect, it } from 'vitest'
import { WORKFLOW_SCRIPT_RPC } from '../../../../shared/workflow-script-types'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { WORKFLOW_SCRIPT_DRY_RUN_METHOD, WORKFLOW_SCRIPT_METHODS } from './workflow-script'

const SCRIPT = `export const meta = { name: 'two-step', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
phase('A')
const first = await parallel((args ?? ['x']).map(item => () => agent('read ' + item, { label: item })))
phase('B')
return agent('sum ' + first.filter(Boolean).length, { model: 'claude-opus-5' })
`

function method(name: string) {
  const found = WORKFLOW_SCRIPT_METHODS.find((entry) => entry.name === name)!
  return (params: unknown) => found.handler(found.params!.parse(params), {} as RpcContext)
}

describe('workflowScript RPC methods', () => {
  it('are registered in the runtime manifest', () => {
    const names = new Set(ALL_RPC_METHODS.map((entry) => entry.name))
    expect(names.has(WORKFLOW_SCRIPT_RPC.readMeta)).toBe(true)
    expect(names.has(WORKFLOW_SCRIPT_RPC.dryRun)).toBe(false)
  })

  it('reads meta without running the script', () => {
    expect(method(WORKFLOW_SCRIPT_RPC.readMeta)({ source: SCRIPT })).toEqual({
      meta: { name: 'two-step', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
    })
    expect(() => method(WORKFLOW_SCRIPT_RPC.readMeta)({ source: 'return 1' })).toThrow(
      'no `export const meta'
    )
  })

  it('dry-runs the script and reports the shape it would run for the given args', async () => {
    const { run } = (await WORKFLOW_SCRIPT_DRY_RUN_METHOD.handler(
      WORKFLOW_SCRIPT_DRY_RUN_METHOD.params!.parse({
        source: SCRIPT,
        args: ['a', 'b', 'c']
      }),
      {} as RpcContext
    )) as {
      run: { status: string; agents: { phaseTitle: string | null; model: string | null }[] }
    }
    expect(run.status).toBe('completed')
    expect(run.agents.map((agent) => agent.phaseTitle)).toEqual(['A', 'A', 'A', 'B'])
    expect(run.agents.at(-1)?.model).toBe('claude-opus-5')
  })

  it('refuses an empty or oversized source before anything runs', () => {
    const readMeta = WORKFLOW_SCRIPT_METHODS.find(
      (entry) => entry.name === WORKFLOW_SCRIPT_RPC.readMeta
    )!
    expect(readMeta.params!.safeParse({ source: '' }).success).toBe(false)
    expect(readMeta.params!.safeParse({ source: 'x'.repeat(256_001) }).success).toBe(false)
    expect(readMeta.params!.safeParse({ source: 'x' }).success).toBe(true)
  })
})
