import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { WorkflowProgramContext } from '../workflow-program-context'
import { createGraphEvidenceChecker } from './graph-evidence-checker'
import { GraphJevStore } from './graph-jev-store'
import { graphHostCallViews } from './graph-jev-view'
import type { GraphCall } from './graph-plan-types'
import { runWorkflowGraphProgram } from './graph-program'
import { configFor, task } from './graph-test-harness'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-evidence-store-'))
  writeFileSync(join(dir, 'a.ts'), 'line one\nconst x = compute()\nline three\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const call = (excerpt = 'const x = compute()'): GraphCall => ({
  id: 'verify/r1/evidence',
  prompt: '',
  schema: {},
  output: 'text',
  seatId: 'evidence',
  dependencies: [],
  stepId: 'verify',
  round: 1,
  agentIndex: 6,
  evidence: { items: [{ key: 'find.r1.1', file: 'a.ts', line: 2, excerpt }] },
  validateSemantics: () => null
})

const store = () => new GraphJevStore(join(dir, 'records', 'evidence.json'))

describe('the evidence checker of one run', () => {
  it('keeps checked quotes and records a gap when evidence.json cannot be written', async () => {
    const broken = store()
    vi.spyOn(broken, 'write').mockImplementation(() => {
      throw new Error('disk full')
    })
    const log = vi.fn()
    const outcome = await createGraphEvidenceChecker({
      store: broken,
      workspace: async () => dir,
      log
    })(call())
    expect(outcome).toMatchObject({
      value: {
        checks: { 'find.r1.1': { status: 'found' } },
        error: 'Evidence checks could not be saved: disk full'
      }
    })
    expect(log).toHaveBeenCalledWith('Evidence checks could not be saved: disk full')
  })

  it('checks once, keeps the result, and replays it without reading the file again', async () => {
    const workspace = vi.fn(async () => dir)
    const first = await createGraphEvidenceChecker({ store: store(), workspace })(call())
    expect(first).toMatchObject({
      value: { checks: { 'find.r1.1': { status: 'found', line: 2 } } }
    })
    rmSync(join(dir, 'a.ts'))
    const replayed = await createGraphEvidenceChecker({ store: store(), workspace })(call())
    expect(replayed).toEqual(first)
    expect(workspace).toHaveBeenCalledTimes(1)
    const cached = await createGraphEvidenceChecker({ store: store(), cacheOnly: true })(call())
    expect(cached).toEqual(first)
  })

  it('fails loudly in a cache-only replay without a record, and on a changed request', async () => {
    const replay = createGraphEvidenceChecker({ store: store(), cacheOnly: true })
    await expect(replay(call())).rejects.toThrow(
      'Evidence check is not recorded: verify/r1/evidence'
    )
    await createGraphEvidenceChecker({ store: store(), workspace: async () => dir })(call())
    await expect(replay(call('something else'))).rejects.toThrow('not recorded')
  })

  it('records a refused workspace as every quote unread, with the reason', async () => {
    const outcome = await createGraphEvidenceChecker({
      store: store(),
      workspace: async () => {
        throw new Error('The workspace folder was moved.')
      }
    })(call())
    expect(outcome).toEqual({
      value: {
        markdown: expect.stringContaining('The workspace could not be read'),
        checks: { 'find.r1.1': { status: 'unreadable', line: 2 } },
        error: 'The workspace folder was moved.'
      }
    })
    expect(store().read('verify/r1/evidence')?.detail).toBe('The workspace folder was moved.')
    const [view] = graphHostCallViews({ evidence: store().all() })
    expect(view).toMatchObject({
      id: 'verify/r1/evidence',
      stageId: 'verify',
      seatLabel: 'Quote check',
      state: 'failed',
      error: 'The quotes could not be checked: The workspace folder was moved.'
    })
  })
})

describe('the program', () => {
  it('answers evidence calls through checkEvidence, never through an agent', async () => {
    const seen: string[] = []
    const agent = vi.fn(async (entry: GraphCall) => {
      if (entry.stepId === 'brief') {
        return { markdown: 'Brief' }
      }
      if (entry.stepId === 'scout') {
        return {
          items: [{ title: 'Area', detail: 'The only area.', location: 'src', severity: 'none' }]
        }
      }
      if (entry.stepId === 'find') {
        return {
          items:
            entry.agentIndex === 0 && entry.round === 1
              ? [
                  {
                    title: 'Inverted check',
                    detail: 'The comparison is inverted.',
                    location: 'a.ts:2',
                    severity: 'high',
                    excerpt: 'const x = compute()',
                    trigger: 'always'
                  }
                ]
              : []
        }
      }
      return { markdown: 'Real.\nVERDICT: PASS' }
    })
    const context = {
      agent,
      parallel: async (work: (() => Promise<unknown>)[]) => Promise.all(work.map((run) => run())),
      guard: () => {},
      phase: () => {},
      log: () => {}
    } as unknown as WorkflowProgramContext
    const config = {
      ...configFor(workflowTemplate('discover', ['claude', 'codex', 'grok'])),
      checkEvidence: async (entry: GraphCall) => {
        seen.push(entry.id)
        return { value: { checks: { [entry.evidence!.items[0]!.key]: { status: 'found' } } } }
      }
    }
    await runWorkflowGraphProgram(context, config, task)
    expect(seen).toEqual(['verify/r1/evidence'])
    expect(agent.mock.calls.some(([entry]) => entry.id.endsWith('/evidence'))).toBe(false)
  })
})
