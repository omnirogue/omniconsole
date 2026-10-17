import { describe, expect, it } from 'vitest'
import { dryRunWorkflowScript, syntheticAnswer } from './workflow-script-dry-run'

const SCRIPT = `export const meta = { name: 'bug-hunt', description: 'd', phases: [{ title: 'Find' }, { title: 'Verify' }] }
const WIDTH = Math.max(1, Math.min(args?.agents ?? 3, 10))
phase('Find')
const found = (await parallel(Array.from({ length: WIDTH }, (_, i) => () =>
  agent('find bugs, lens ' + i, { label: 'find:' + i, model: i % 2 ? 'gpt-6' : 'claude-opus-5', schema: {
    type: 'object', properties: { bugs: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' } } } } }, required: ['bugs'] } })
))).filter(Boolean).flatMap(r => r.bugs)
if (!found.length) { log('nothing found'); return { bugs: 0 } }
phase('Verify')
const verdicts = await pipeline(found, b => agent('refute ' + b.file, { phase: 'Verify', label: 'refute:' + b.file, schema: {
  type: 'object', properties: { refuted: { type: 'boolean' } }, required: ['refuted'] } }))
return { bugs: found.length, kept: verdicts.filter(v => v && !v.refuted).length }
`

describe('dryRunWorkflowScript', () => {
  it('executes the script against a synthetic world and reports the shape it would run', async () => {
    const snapshot = await dryRunWorkflowScript({
      source: SCRIPT,
      args: { agents: 2 },
      richness: 3
    })
    expect(snapshot.status).toBe('completed')
    expect(snapshot.phases).toEqual(['Find', 'Verify'])
    expect(snapshot.agents.filter((a) => a.phaseTitle === 'Find')).toHaveLength(2)
    expect(snapshot.agents.filter((a) => a.phaseTitle === 'Verify')).toHaveLength(6)
    expect(snapshot.agents.every((a) => a.state === 'done')).toBe(true)
    expect(snapshot.agents.map((a) => a.model).slice(0, 2)).toEqual(['claude-opus-5', 'gpt-6'])
    expect(snapshot.result).toEqual({ bugs: 6, kept: expect.any(Number) })
    expect(snapshot.tokens).toBeGreaterThan(0)
  })

  it('shows data-driven fan-out responding to the world: an empty world verifies nothing', async () => {
    const snapshot = await dryRunWorkflowScript({
      source: SCRIPT,
      args: { agents: 2 },
      richness: 0
    })
    expect(snapshot.agents).toHaveLength(2)
    expect(snapshot.logs).toEqual(['nothing found'])
    expect(snapshot.result).toEqual({ bugs: 0 })
  })

  it('reports a broken script as failed with the reason, not as an empty plan', async () => {
    const snapshot = await dryRunWorkflowScript({
      source: 'export const meta = { name: "x", description: "d" }\nreturn Date.now()'
    })
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toContain('Date.now()')
  })
})

describe('syntheticAnswer', () => {
  it('honours enums, bounds, item counts and alternates booleans', () => {
    expect(syntheticAnswer({ type: 'string', enum: ['a', 'b'] }, 3, 1)).toBe('b')
    expect(syntheticAnswer({ type: 'array', maxItems: 2 }, 5)).toHaveLength(2)
    expect(syntheticAnswer({ type: 'array', minItems: 1 }, 0)).toHaveLength(1)
    expect(syntheticAnswer({ type: 'integer', maximum: 2 }, 3, 6)).toBe(2)
    expect([0, 1, 2, 3].map((seed) => syntheticAnswer({ type: 'boolean' }, 1, seed))).toEqual([
      false,
      true,
      true,
      false
    ])
  })
})
