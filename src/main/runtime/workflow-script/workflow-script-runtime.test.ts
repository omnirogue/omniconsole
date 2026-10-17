import { describe, expect, it, vi } from 'vitest'
import type { WorkflowScriptEvent } from '../../../shared/workflow-script-types'
import { MemoryWorkflowScriptJournal } from './workflow-script-journal'
import {
  runWorkflowScript,
  type WorkflowScriptExecutor,
  type RunWorkflowScriptOptions
} from './workflow-script-runtime'

const META = `export const meta = { name: 'demo', description: 'd', phases: [{ title: 'Find' }, { title: 'Verify' }] }\n`

const echo: WorkflowScriptExecutor = async (call) => ({
  value: call.schema
    ? { findings: [{ file: `${call.label}.ts` }], refuted: call.index % 2 === 0 }
    : `text ${call.index}`,
  tokens: 100
})

function run(source: string, extra: Partial<RunWorkflowScriptOptions> = {}) {
  const events: WorkflowScriptEvent[] = []
  return runWorkflowScript({
    source,
    execute: echo,
    maxConcurrent: 4,
    timeoutMs: 5_000,
    clock: (() => {
      let now = 1_000
      return () => (now += 10)
    })(),
    onEvent: (event) => events.push(event),
    ...extra
  }).then((snapshot) => ({ snapshot, events }))
}

describe('runWorkflowScript', () => {
  it('runs a find → verify script, groups agents by phase and returns the script result', async () => {
    const { snapshot, events } = await run(`${META}
      phase('Find')
      const found = await parallel(['a', 'b'].map(f => () => agent('find in ' + f, { label: f, schema: { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'] } })))
      phase('Verify')
      const verified = await pipeline(found.filter(Boolean).flatMap(r => r.findings), f => agent('refute ' + f.file, { phase: 'Verify', schema: { type: 'object', properties: { refuted: { type: 'boolean' } }, required: ['refuted'] } }))
      log('checked ' + verified.length)
      return { found: found.length, verified: verified.filter(v => v && !v.refuted).length }
    `)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.meta?.name).toBe('demo')
    expect(snapshot.phases).toEqual(['Find', 'Verify'])
    expect(snapshot.agents.map((a) => [a.phaseTitle, a.state])).toEqual([
      ['Find', 'done'],
      ['Find', 'done'],
      ['Verify', 'done'],
      ['Verify', 'done']
    ])
    expect(snapshot.agents.map((a) => a.phaseIndex)).toEqual([1, 1, 2, 2])
    expect(snapshot.result).toEqual({ found: 2, verified: 1 })
    expect(snapshot.logs).toEqual(['checked 2'])
    expect(snapshot.tokens).toBe(400)
    expect(events.filter((e) => e.type === 'phase')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'agent' && e.agent.state === 'running')).toHaveLength(4)
  })

  it('never lets an agent read the clock or randomness, and names the reason', async () => {
    for (const expression of ['Date.now()', 'new Date()', 'Math.random()']) {
      const { snapshot } = await run(`${META}\nconst x = ${expression}\nreturn x`)
      expect(snapshot.status).toBe('failed')
      expect(snapshot.error).toContain('would break resume')
    }
    const { snapshot } = await run(
      `${META}\nreturn [Math.max(1, 2), new Date(0).getTime(), typeof require, typeof process]`
    )
    expect(snapshot.status).toBe('completed')
    expect(snapshot.result).toEqual([2, 0, 'undefined', 'undefined'])
  })

  it('turns a dead agent into null for the script, and a thrown thunk into null inside parallel', async () => {
    const execute: WorkflowScriptExecutor = async (call) =>
      call.label === 'dies' ? null : { value: 'ok', tokens: 1 }
    const { snapshot } = await run(
      `${META}\nconst r = await parallel([() => agent('one', { label: 'dies' }), () => agent('two', { label: 'lives' }), () => { throw new Error('boom') }])\nreturn r`,
      { execute }
    )
    expect(snapshot.result).toEqual([null, 'ok', null])
    expect(snapshot.agents.map((a) => [a.label, a.state, a.error])).toEqual([
      ['dies', 'failed', 'agent did not answer'],
      ['lives', 'done', null]
    ])
  })

  it('asks again with the defects when an answer misses its schema, then gives up honestly', async () => {
    const seen: (string | null)[] = []
    const execute: WorkflowScriptExecutor = async (_call, context) => {
      seen.push(context.problems)
      return { value: context.attempt === 2 ? { n: 1 } : { n: 'no' }, tokens: 1 }
    }
    const schema = `{ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }`
    const { snapshot } = await run(`${META}\nreturn agent('count', { schema: ${schema} })`, {
      execute
    })
    expect(snapshot.result).toEqual({ n: 1 })
    expect(seen).toEqual([null, 'n: expected integer, got string'])
    expect(snapshot.agents[0]!.attempt).toBe(2)

    const stubborn: WorkflowScriptExecutor = async () => ({ value: { n: 'never' }, tokens: 1 })
    const failed = await run(`${META}\nreturn agent('count', { schema: ${schema} })`, {
      execute: stubborn
    })
    expect(failed.snapshot.result).toBeNull()
    expect(failed.snapshot.agents[0]!.state).toBe('failed')
    expect(failed.snapshot.agents[0]!.error).toContain('never matched its schema')
    expect(failed.snapshot.agents[0]!.attempt).toBe(3)
  })

  it('refuses an unusable schema at the call, not when the answer comes back', async () => {
    const { snapshot } = await run(`${META}\nreturn agent('x', { schema: { type: 'array' } })`)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toContain("schema root must have type 'object'")
  })

  it('answers unchanged calls from the journal on a re-run and runs only what changed', async () => {
    const journal = new MemoryWorkflowScriptJournal()
    const execute = vi.fn(echo)
    const script = (extra: string) =>
      `${META}\nconst a = await agent('first')\nconst b = await agent('first')\n${extra}\nreturn [a, b]`
    const first = await run(script(''), { execute, journal })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(first.snapshot.cachedAgents).toBe(0)
    expect(first.snapshot.agents.map((a) => a.key.split(':').at(-1))).toEqual(['1', '2'])

    execute.mockClear()
    const second = await run(script(`const c = await agent('third')`), { execute, journal })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0].prompt).toBe('third')
    expect(second.snapshot.cachedAgents).toBe(2)
    expect(second.snapshot.agents.map((a) => a.cached)).toEqual([true, true, false])
    expect(second.snapshot.result).toEqual(['text 1', 'text 2'])
  })

  it('journals nothing for a failed answer', async () => {
    const journal = new MemoryWorkflowScriptJournal()
    const execute: WorkflowScriptExecutor = async () => null
    await run(`${META}\nreturn agent('x')`, { execute, journal })
    expect(journal.size).toBe(0)
  })

  it('caps agents running at once and queues the rest', async () => {
    let running = 0
    let peak = 0
    const execute: WorkflowScriptExecutor = async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
      return { value: 'x', tokens: 1 }
    }
    const { snapshot } = await run(
      `${META}\nreturn parallel(Array.from({ length: 9 }, (_, i) => () => agent('p' + i)))`,
      { execute, maxConcurrent: 3 }
    )
    expect(snapshot.agents).toHaveLength(9)
    expect(peak).toBe(3)
  })

  it('stops at the token budget and tells the script so it can shrink instead of dying', async () => {
    const { snapshot } = await run(
      `${META}\nconst out = []\nwhile (budget.total && budget.remaining() > 150) { out.push(await agent('more ' + out.length)) }\nreturn { count: out.length, spent: budget.spent() }`,
      { budgetTotal: 450 }
    )
    expect(snapshot.status).toBe('completed')
    expect(snapshot.result).toEqual({ count: 3, spent: 300 })
    const exhausted = await run(`${META}\nawait agent('a')\nawait agent('b')\nreturn 'never'`, {
      budgetTotal: 100
    })
    expect(exhausted.snapshot.status).toBe('failed')
    expect(exhausted.snapshot.error).toContain('token budget exhausted')
  })

  it('backstops a runaway loop by the agent cap and reports the run failed', async () => {
    const { snapshot } = await run(`${META}\nwhile (true) { await agent('again') }`, {
      maxAgents: 5
    })
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toContain('runaway fan-out')
    expect(snapshot.agents).toHaveLength(5)
  })

  it('reports a syntax error without running anything', async () => {
    const { snapshot } = await run(`${META}\nconst = 1`)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toContain('syntax error')
    expect(snapshot.agents).toEqual([])
  })

  it('can be cancelled; queued and running seats read failed with the reason', async () => {
    const controller = new AbortController()
    const execute: WorkflowScriptExecutor = async (_call, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener('abort', () => resolve(null))
        setTimeout(() => controller.abort(), 5)
      })
    const { snapshot } = await run(
      `${META}\nreturn parallel([() => agent('a'), () => agent('b')])`,
      {
        execute,
        maxConcurrent: 1,
        signal: controller.signal
      }
    )
    expect(snapshot.status).toBe('cancelled')
    expect(snapshot.agents.map((a) => a.state)).toEqual(['failed', 'failed'])
  })
})
