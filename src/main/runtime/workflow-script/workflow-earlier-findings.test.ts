import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { runWorkflowGraphProgram } from './graph/graph-program'
import { configFor, fakeContext, text, task } from './graph/graph-program-test-harness'
import type { WorkflowRunTarget } from '../../../shared/workflow-run-result'
import {
  EARLIER_RUNS_LABEL,
  EARLIER_TITLE_MAX_CHARS,
  EARLIER_UNCONFIRMED,
  graphEarlierFindings,
  graphEarlierHold,
  readWorkflowEarlierFindings,
  repeatsEarlierLine,
  workflowEarlierRunsEnabled,
  type WorkflowEarlierSettled
} from './workflow-earlier-findings'

const databases: OrchestrationDb[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

type Target = {
  title: string
  location?: string
  severity?: WorkflowRunTarget['severity']
  tally?: WorkflowRunTarget['tally']
  screened?: true
  dropped?: true
}

function store() {
  const orchestration = new OrchestrationDb(':memory:')
  databases.push(orchestration)
  const { db } = orchestration
  let sequence = 0
  const settledRuns = new Map<string, WorkflowEarlierSettled>()
  const run = (
    snapshot: unknown,
    calls: Record<string, unknown>,
    options: { state?: string; quarantined?: string[] } = {}
  ) => {
    const id = `run-${++sequence}`
    db.prepare(
      `INSERT INTO local_workflow_executions (id, conversation_id, request_id, snapshot_json, snapshot_digest, preset, fence, state, attempt_limit, call_limit, budget_limit) VALUES (?, ?, ?, ?, 'digest', 'discover', 1, ?, 1, 1, 1)`
    ).run(
      id,
      `conversation-${id}`,
      'request',
      JSON.stringify({ snapshot }),
      options.state ?? 'completed'
    )
    for (const [callId, result] of Object.entries(calls)) {
      db.prepare(
        'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest, result_json, quarantined) VALUES (?, ?, ?, ?, ?)'
      ).run(
        id,
        callId,
        'input',
        JSON.stringify(result),
        options.quarantined?.includes(callId) ? 1 : 0
      )
    }
    return id
  }
  /** A settled graph run: its run result's targets, as the settled reader reports them. */
  const graph = (
    startedAt: number,
    targets: Target[],
    options: {
      template?: string
      workspaceId?: string
      commit?: string
      state?: string
      isolated?: true
      actedOn?: string[]
    } = {}
  ) => {
    const id = run(
      {
        graph: { spec: { template: options.template ?? 'discover' } },
        host: {
          workspaceId: options.workspaceId ?? 'repo::/work/app',
          startedAt,
          ...(options.isolated ? { isolated: true } : {}),
          context: {
            entries: [
              { kind: 'github', repo: 'o/app', ref: 'main', commit: options.commit ?? 'a1' }
            ]
          }
        }
      },
      {},
      options
    )
    settledRuns.set(id, {
      targets: targets.map(
        (target, index) =>
          ({
            step: 'verify',
            round: 1,
            key: `find.r1.${index + 1}`,
            title: target.title,
            location: target.location ?? '',
            severity: target.severity ?? 'none',
            tally: target.tally ?? 'confirmed',
            votes: [],
            repeats: 0,
            ...(target.screened ? { screened: true } : {}),
            ...(target.dropped ? { preVerify: { dropped: true, flags: [] } } : {}),
            detail: ''
          }) as WorkflowRunTarget
      ),
      actedOn: new Set(options.actedOn ?? [])
    })
    return id
  }
  const settled = (id: string) => settledRuns.get(id)
  const target = (commit = 'b2', goal?: string) => ({
    template: 'discover',
    workspaceId: 'repo::/work/app',
    context: [{ kind: 'github', repo: 'o/app', ref: 'main', commit }] as never,
    ...(goal ? { goal } : {})
  })
  const read = (goal?: string) => readWorkflowEarlierFindings(db, target('b2', goal), settled)
  return { db, run, graph, target, settled, read }
}

describe('cross-run known list', () => {
  it('lists the newest same-target runs first: confirmed, then unverified labelled, never refuted', () => {
    const { graph, read } = store()
    const older = graph(1, [
      { title: 'Cache key ignores locale', location: 'src/cache/key.ts:10', severity: 'low' },
      { title: 'Store write races flush', location: 'src/store/write.ts:40', severity: 'critical' }
    ])
    const newer = graph(
      2,
      [
        {
          title: 'Cache keys ignore the locale',
          location: 'src/cache/key.ts:12',
          severity: 'high'
        },
        {
          title: 'Late call',
          location: 'src/late.ts:1',
          severity: 'critical',
          tally: 'unverified'
        },
        { title: 'Token refresh loops', location: 'src/auth/token.ts:5', severity: 'medium' },
        { title: 'Refuted claim', location: 'src/r.ts:1', severity: 'critical', tally: 'refuted' },
        { title: 'No such file', location: 'src/x.ts:1', tally: 'unverified', dropped: true },
        { title: 'Screened out', location: 'src/s.ts:1', tally: 'unverified', screened: true }
      ],
      // Another commit of the same branch is the same target.
      { commit: 'a0' }
    )
    graph(3, [{ title: 'Failed run', location: 'src/f.ts:1' }], { state: 'failed' })
    graph(4, [{ title: 'Other workspace', location: 'src/o.ts:1' }], {
      workspaceId: 'repo::/work/other'
    })
    graph(5, [{ title: 'Other template', location: 'src/t.ts:1' }], {
      template: 'quick-discover'
    })
    // A benchmark rep or --no-earlier-runs run.
    graph(6, [{ title: 'Isolated run', location: 'src/i.ts:1' }], { isolated: true })
    expect(read()).toEqual({
      step: 'find',
      runs: [newer, older],
      titles: [
        'Cache keys ignore the locale (src/cache/key.ts:12)',
        'Token refresh loops (src/auth/token.ts:5)',
        `Late call (src/late.ts:1)${EARLIER_UNCONFIRMED}`,
        'Store write races flush (src/store/write.ts:40)'
      ],
      holdRepeats: true
    })
  })

  it('lists what the person acted on first, whatever its verdict', () => {
    const { graph, read } = store()
    graph(
      1,
      [
        { title: 'Confirmed', location: 'src/a.ts:1', severity: 'critical' },
        { title: 'Picked while unverified', location: 'src/b.ts:1', tally: 'unverified' }
      ],
      { actedOn: ['find.r1.2'] }
    )
    expect(read()!.titles).toEqual([
      'Picked while unverified (src/b.ts:1)',
      'Confirmed (src/a.ts:1)'
    ])
  })

  it('leaves out a run whose verdicts cannot be read', () => {
    const { db, graph, target } = store()
    graph(1, [{ title: 'Seen', location: 'src/s.ts:1' }])
    expect(readWorkflowEarlierFindings(db, target())).toBeUndefined()
    expect(
      readWorkflowEarlierFindings(db, target(), () => {
        throw new Error('unreadable')
      })
    ).toBeUndefined()
  })

  it('gives each of the last five runs a fair share of the fifty lines', () => {
    const { graph, read } = store()
    const ids = Array.from({ length: 7 }, (_, run) =>
      graph(
        run,
        Array.from({ length: 12 }, (_, i) => ({
          title: `Defect ${run} ${i}`,
          location: `src/run${run}/file${i}.ts:1`
        }))
      )
    )
    const earlier = read()!
    expect(earlier.titles).toHaveLength(50)
    expect(earlier.runs).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]])
    for (const run of [6, 5, 4, 3, 2]) {
      expect(earlier.titles.filter((line) => line.startsWith(`Defect ${run} `))).toHaveLength(10)
    }

    // One large run never crowds out a smaller one.
    const few = store()
    const small = few.graph(1, [{ title: 'Older defect', location: 'src/old.ts:1' }])
    const large = few.graph(
      2,
      Array.from({ length: 80 }, (_, i) => ({ title: `Newer ${i}`, location: `src/n${i}.ts:1` }))
    )
    const shared = few.read()!
    expect(shared.runs).toEqual([large, small])
    expect(shared.titles).toHaveLength(50)
    expect(shared.titles.at(-1)).toBe('Older defect (src/old.ts:1)')
  })

  it('lists the titles that share words with the goal first', () => {
    const { graph, read } = store()
    graph(1, [
      { title: 'Token refresh loops', location: 'src/auth.ts:1' },
      { title: 'Cache eviction skips locked rows', location: 'src/cache.ts:1' }
    ])
    expect(read('Improve how the cache eviction works')!.titles).toEqual([
      'Cache eviction skips locked rows (src/cache.ts:1)',
      'Token refresh loops (src/auth.ts:1)'
    ])
    expect(read()!.titles[0]).toBe('Token refresh loops (src/auth.ts:1)')
  })

  it('holds only confirmed lines, matching a report exactly', () => {
    const lines = graphEarlierHold({
      host: {
        earlierFindings: {
          step: 'find',
          runs: ['r'],
          titles: [
            'Store write races (src/a.ts:4)',
            `Late call (src/b.ts:1)${EARLIER_UNCONFIRMED}`
          ],
          holdRepeats: true
        }
      }
    }).earlierHold!
    expect(lines).toEqual({ step: 'find', lines: ['store write races (src/a.ts:4)'] })
    const report = (title: string, location: string) =>
      ({ title, location, detail: '', severity: 'high' }) as const
    expect(repeatsEarlierLine(lines.lines, report('Store  write RACES', 'src/a.ts:4'))).toBe(true)
    expect(repeatsEarlierLine(lines.lines, report('Store write races', 'src/a.ts:5'))).toBe(false)
    expect(repeatsEarlierLine(lines.lines, report('Late call', 'src/b.ts:1'))).toBe(false)
    // Lists frozen before the hold existed replay as they ran.
    expect(
      graphEarlierHold({
        host: { earlierFindings: { step: 'find', runs: ['r'], titles: ['Store write races'] } }
      })
    ).toEqual({})
  })

  it('cuts a long title line, keeping its label', () => {
    const { graph, read } = store()
    graph(1, [
      { title: 'x'.repeat(400), severity: 'high' },
      { title: 'y'.repeat(400), tally: 'unverified' }
    ])
    const [line, unverified] = read()!.titles
    expect(line).toHaveLength(EARLIER_TITLE_MAX_CHARS)
    expect(line.endsWith('…')).toBe(true)
    expect(unverified).toHaveLength(EARLIER_TITLE_MAX_CHARS)
    expect(unverified.endsWith(`…${EARLIER_UNCONFIRMED}`)).toBe(true)
  })

  it('lists nothing for unseeded templates, a missing workspace or no earlier result', () => {
    const { db, graph, target, settled, read } = store()
    graph(1, [{ title: 'Seen', location: 'src/s.ts:1' }], { template: 'research' })
    expect(
      readWorkflowEarlierFindings(db, { ...target(), template: 'research' }, settled)
    ).toBeUndefined()
    expect(readWorkflowEarlierFindings(db, { template: 'discover' }, settled)).toBeUndefined()
    expect(read()).toBeUndefined()
    graph(2, [])
    graph(3, [{ title: 'Refuted', location: 'src/r.ts:1', tally: 'refuted' }])
    expect(read()).toBeUndefined()
  })

  it("reads an Audit's final themes by corpus file and format", () => {
    const { db, run } = store()
    const audit = (startedAt: number, format: string, calls: Record<string, unknown>) =>
      run({ audit: { sourceFile: '/data/chat.jsonl', format }, host: { startedAt } }, calls)
    const merged = audit(1, 'sources-jsonl', {
      'audit/merge': { version: 1, findings: [{ title: 'Repeated manual export' }] }
    })
    const novel = audit(2, 'sources-jsonl', {
      'audit/merge': { version: 1, findings: [{ title: 'Not the final themes' }] },
      'audit/novelty-merge': { version: 1, findings: [{ title: 'Missed onboarding request' }] }
    })
    audit(3, 'digests-jsonl', {
      'audit/merge': { version: 1, findings: [{ title: 'Another format' }] }
    })
    expect(
      readWorkflowEarlierFindings(db, {
        auditSource: { file: '/data/chat.jsonl', format: 'sources-jsonl' }
      })
    ).toEqual({
      step: 'novelty',
      runs: [novel, merged],
      titles: ['Missed onboarding request', 'Repeated manual export']
    })
  })

  it('is on unless the environment turns it off', () => {
    expect(workflowEarlierRunsEnabled({})).toBe(true)
    expect(workflowEarlierRunsEnabled({ OMNI_WORKFLOW_EARLIER_RUNS: '1' })).toBe(true)
    for (const value of ['0', 'off', 'FALSE', ' no ']) {
      expect(workflowEarlierRunsEnabled({ OMNI_WORKFLOW_EARLIER_RUNS: value })).toBe(false)
    }
  })

  it('maps a frozen list into the graph config and nothing otherwise', () => {
    expect(graphEarlierFindings({})).toEqual({})
    expect(
      graphEarlierFindings({ host: { earlierFindings: { step: 'find', runs: [], titles: [] } } })
    ).toEqual({})
    expect(
      graphEarlierFindings({
        host: { earlierFindings: { step: 'find', runs: ['r'], titles: ['A'] } }
      })
    ).toEqual({ earlier: { step: 'find', titles: ['A'] } })
  })

  it("shows the list to the seeded step's agents only", async () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        {
          id: 'find',
          kind: 'do',
          title: 'Find',
          agents: [{ route: 'claude' }, { route: 'codex' }],
          list: { maxItems: 3 }
        },
        { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['find'] }
      ]
    })
    const prompts = async (earlier?: { step: string; titles: string[] }) => {
      const { context, calls } = fakeContext((call) =>
        call.id.startsWith('find') ? { items: [] } : text('Report')
      )
      await runWorkflowGraphProgram(
        context,
        { ...configFor(spec), ...(earlier ? { earlier } : {}) },
        task
      )
      return Object.fromEntries(calls.map((call) => [call.id, call.prompt]))
    }
    const plain = await prompts()
    const seeded = await prompts({ step: 'find', titles: ['Old bug (src/a.ts:1)'] })
    const finders = Object.keys(plain).filter((id) => id.startsWith('find'))
    expect(finders).toHaveLength(2)
    for (const id of finders) {
      expect(plain[id]).not.toContain(EARLIER_RUNS_LABEL)
      expect(seeded[id]).toContain(`${EARLIER_RUNS_LABEL}:`)
      expect(seeded[id]).toContain('- Old bug (src/a.ts:1)')
    }
    const others = Object.keys(plain).filter((id) => !id.startsWith('find'))
    expect(others.length).toBeGreaterThan(0)
    for (const id of others) {
      expect(seeded[id]).toBe(plain[id])
    }
    // A list frozen for a step this spec no longer has changes no prompt.
    expect(await prompts({ step: 'gone', titles: ['Old bug'] })).toEqual(plain)
  })

  it('holds a Find report that repeats a confirmed earlier line exactly', async () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        {
          id: 'find',
          kind: 'do',
          title: 'Find',
          agents: [{ route: 'claude' }],
          list: { maxItems: 5 }
        },
        { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['find'] }
      ]
    })
    const item = (title: string, location: string) => ({
      title,
      detail: 'Seen in the code',
      location,
      severity: 'high'
    })
    const { context, calls } = fakeContext((call) =>
      call.id.startsWith('find')
        ? { items: [item('Old bug', 'src/a.ts:1'), item('New bug', 'src/b.ts:9')] }
        : text('Report')
    )
    await runWorkflowGraphProgram(
      context,
      {
        ...configFor(spec),
        ...graphEarlierFindings({
          host: {
            earlierFindings: {
              step: 'find',
              runs: ['r'],
              titles: ['Old bug (src/a.ts:1)'],
              holdRepeats: true
            }
          }
        }),
        earlierHold: { step: 'find', lines: ['old bug (src/a.ts:1)'] }
      },
      task
    )
    const report = calls.find((call) => call.id.startsWith('report'))!.prompt
    expect(report).toContain('New bug')
    expect(report).not.toContain('Old bug')
  })
})
