import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { ROOT_HELP_TEXT_PRIMARY } from '../root-help-text-primary'
import { COMMAND_SPECS } from '../specs'
import { LOCAL_WORKFLOW_METHODS } from '../../shared/local-workflow-rpc'
import { localWorkflowRunRequestSchema } from '../../shared/local-workflow-run-request'
import type { LocalWorkflowView } from '../../shared/local-workflow-view'
import type { WorkflowRunResult } from '../../shared/workflow-run-result'
import { FIND_BEST_HANDLERS } from './find-best'
import { runRequestFromFlags } from './workflow-run'

const STARTED = {
  worktreeId: 'wt-1',
  conversationId: 'discover-tab',
  executionId: '3f9a1c2e-0000-4000-8000-000000000000'
}

const seat = { seatId: 's1', agent: 'claude', model: 'opus', modelLabel: 'Opus', effort: null }
const call = (id: string, extra: Record<string, unknown>) => ({
  id,
  stageId: id.split('/')[0],
  agent: 'claude',
  model: 'opus',
  effort: 'high',
  attempt: 1,
  ...extra
})

const DONE = {
  executionId: STARTED.executionId,
  state: 'completed',
  startedAt: 1_000,
  finishedAt: 61_000,
  phase: 'Report',
  result: { markdown: '## Findings\n1. Race in queue', sources: [], coverage: [] },
  calls: [
    call('find/1', {
      state: 'completed',
      startedAt: 2_000,
      endedAt: 12_000,
      tokens: { input: 900, output: 80 }
    }),
    call('verify/1', { state: 'completed' })
  ],
  usage: { hostAttempts: 2, maxHostAttempts: 40, tokens: null },
  graphRun: {
    spec: {
      steps: [
        { id: 'find', kind: 'do' },
        { id: 'verify', kind: 'review' }
      ]
    },
    levels: {},
    steps: [
      {
        id: 'find',
        state: 'done',
        agents: [seat],
        rounds: [{ round: 1, state: 'done', calls: [], notes: [] }]
      },
      {
        id: 'verify',
        state: 'done',
        agents: [seat],
        rounds: [
          {
            round: 1,
            state: 'done',
            calls: [],
            notes: [],
            targets: [
              {
                key: 'k1',
                title: 'Race in queue',
                detail: 'Two workers take the same job',
                location: 'src/queue.ts:40-52',
                severity: 'high',
                repeats: 2,
                jev: { score: 3.4 },
                tally: 'confirmed',
                votes: ['pass']
              }
            ]
          }
        ]
      }
    ],
    gaps: ['The area src/legacy was not searched.'],
    notes: []
  }
} as unknown as LocalWorkflowView

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(
      argv,
      COMMAND_SPECS.map((spec) => spec.path)
    )
  )
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

function client(views: LocalWorkflowView[]) {
  const shown = [...views]
  return vi.fn(async (method: string, params: unknown) => {
    if (method === 'worktree.list') {
      return { result: { worktrees: [{ id: 'wt-1', path: '/work' }] } }
    }
    if (method === LOCAL_WORKFLOW_METHODS.run) {
      return { result: STARTED, params }
    }
    return { result: shown.length > 1 ? shown.shift() : shown[0] }
  })
}

function run(argv: string[], rpc: ReturnType<typeof client>, json = false, cwd = '/work') {
  const parsed = parse(argv)
  return FIND_BEST_HANDLERS[parsed.commandPath.join(' ')]!({
    client: { call: rpc, isRemote: false },
    flags: parsed.flags,
    cwd,
    json
  } as unknown as HandlerContext)
}

let dir = ''
let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('omni workflow run', () => {
  it('reads the template, prompt, routes and spec override, and names a mistake first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'workflow-run-'))
    await writeFile(join(dir, 'goal.md'), 'Find bugs in src/queue\n')
    await writeFile(join(dir, 'arm.json'), '{"steps":{"verify":{"escalate":{"max":0}}}}')
    await expect(
      runRequestFromFlags(
        parse([
          'workflow',
          'run',
          '--template',
          'discover',
          '--prompt-file',
          'goal.md',
          '--routes',
          'claude, codex',
          '--runs-on',
          'local',
          '--spec-file',
          'arm.json'
        ]).flags,
        dir
      )
    ).resolves.toEqual({
      template: 'discover',
      prompt: 'Find bugs in src/queue',
      routes: ['claude', 'codex'],
      runsOn: 'local',
      spec: { steps: { verify: { escalate: { max: 0 } } } }
    })
    // Unsaid, the request still says fleet: a runtime from before placement (whose strict
    // schema lacks the field) then rejects it by name instead of running it on itself.
    const unsaid = await runRequestFromFlags(
      parse(['workflow', 'run', '--template', 'council', '--prompt', 'x']).flags,
      dir
    )
    expect(unsaid.runsOn).toBe('fleet')
    expect(unsaid).not.toHaveProperty('skipEarlierRuns')
    const fresh = await runRequestFromFlags(
      parse(['workflow', 'run', '--template', 'discover', '--prompt', 'x', '--no-earlier-runs'])
        .flags,
      dir
    )
    expect(fresh.skipEarlierRuns).toBe(true)
    const legacySchema = localWorkflowRunRequestSchema.omit({ runsOn: true })
    expect(legacySchema.safeParse(unsaid).success).toBe(false)
    await expect(
      runRequestFromFlags(
        parse(['workflow', 'run', '--template', 'council', '--prompt', 'x', '--runs-on', 'cloud'])
          .flags,
        dir
      )
    ).rejects.toThrow('--runs-on: choose fleet (the default) or local.')
    await expect(
      runRequestFromFlags(
        parse(['workflow', 'run', '--template', 'nope', '--prompt', 'x']).flags,
        dir
      )
    ).rejects.toThrow('--template: choose one of discover, council')
    await expect(
      runRequestFromFlags(parse(['workflow', 'run', '--template', 'council']).flags, dir)
    ).rejects.toThrow('--prompt')
    await expect(
      runRequestFromFlags(
        parse(['workflow', 'run', '--template', 'council', '--prompt', 'x', '--routes', 'hal'])
          .flags,
        dir
      )
    ).rejects.toThrow('--routes')
    await expect(
      runRequestFromFlags(
        parse([
          'workflow',
          'run',
          '--template',
          'council',
          '--prompt',
          'x',
          '--spec-file',
          'goal.md'
        ]).flags,
        dir
      )
    ).rejects.toThrow('--spec-file: goal.md is not JSON.')
    expect(ROOT_HELP_TEXT_PRIMARY).toContain('  workflow run ')
  })

  it('sends --depth only when given, and only for Discover', async () => {
    const flags = (...extra: string[]) =>
      parse(['workflow', 'run', '--template', 'discover', '--prompt', 'x', ...extra]).flags
    for (const depth of ['quick', 'thorough'] as const) {
      expect(await runRequestFromFlags(flags('--depth', depth), '/work')).toEqual({
        template: 'discover',
        prompt: 'x',
        runsOn: 'fleet',
        depth
      })
    }
    // Unsaid, the key is absent: a runtime from before --depth (strict, without it) still starts it.
    const unsaid = await runRequestFromFlags(flags(), '/work')
    expect(unsaid).toEqual({ template: 'discover', prompt: 'x', runsOn: 'fleet' })
    const legacySchema = localWorkflowRunRequestSchema.omit({ depth: true })
    expect(legacySchema.safeParse(unsaid).success).toBe(true)
    expect(
      legacySchema.safeParse(await runRequestFromFlags(flags('--depth', 'quick'), '/work')).success
    ).toBe(false)
    for (const bad of [['--depth', 'deep'], ['--depth']]) {
      await expect(runRequestFromFlags(flags(...bad), '/work')).rejects.toThrow(
        '--depth: choose quick or thorough (the default).'
      )
    }
    for (const template of ['council', 'quick-discover', 'investigate']) {
      await expect(
        runRequestFromFlags(
          parse(['workflow', 'run', '--template', template, '--prompt', 'x', '--depth', 'quick'])
            .flags,
          '/work'
        )
      ).rejects.toThrow(`--depth applies to --template discover only, not ${template}.`)
    }
    const rpc = client([DONE])
    await expect(run(['workflow', 'run', 'evolve', '--depth', 'quick'], rpc)).rejects.toThrow(
      '--depth applies to --template discover only, not evolve.'
    )
    expect(rpc).not.toHaveBeenCalled()
  })

  it('starts the run in the app, follows it to settled and prints the benchmark JSON', async () => {
    const rpc = client([
      { ...DONE, state: 'running', finishedAt: undefined } as LocalWorkflowView,
      DONE
    ])
    const done = run(
      ['workflow', 'run', '--template', 'discover', '--prompt', 'Find bugs'],
      rpc,
      true
    )
    await vi.runAllTimersAsync()
    await done
    expect(rpc).toHaveBeenCalledWith(
      LOCAL_WORKFLOW_METHODS.run,
      {
        worktree: 'id:wt-1',
        request: {
          template: 'discover',
          prompt: 'Find bugs',
          origin: 'cli',
          runsOn: 'fleet',
          operationId: expect.any(String)
        }
      },
      { timeoutMs: 150_000 }
    )
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as WorkflowRunResult
    expect(printed).toMatchObject({
      ...STARTED,
      template: 'discover',
      state: 'completed',
      markdown: '## Findings\n1. Race in queue',
      gaps: ['The area src/legacy was not searched.'],
      timing: { wallClockMs: 60_000 },
      // One call reported and one did not: the total is unknown, the known part is labelled partial.
      usage: {
        tokens: 'unknown',
        partialTokens: { input: 900, output: 80, knownCalls: 1, unknownCalls: 1 },
        callsWithTokens: 1,
        callsTotal: 2,
        costUsd: 'unknown'
      }
    })
    expect(printed.results.targets).toEqual([
      expect.objectContaining({
        step: 'verify',
        key: 'k1',
        location: 'src/queue.ts:40-52',
        severity: 'high',
        tally: 'confirmed',
        jevScore: 3.4
      })
    ])
    expect(printed.results.steps.map((step) => `${step.id}:${step.kind}`)).toEqual([
      'find:do',
      'verify:review'
    ])
    // A call without a receipt is unknown, never 0.
    expect(printed.calls).toEqual([
      expect.objectContaining({
        id: 'find/1',
        durationMs: 10_000,
        tokens: { input: 900, output: 80 }
      }),
      expect.objectContaining({ id: 'verify/1', durationMs: 'unknown', tokens: 'unknown' })
    ])
  })

  it('sends the requester id with the run and refuses invalid ids before starting', async () => {
    const argv = [
      'workflow',
      'run',
      '--template',
      'discover',
      '--prompt',
      'Find bugs',
      '--no-follow'
    ]
    const asking = ['--requested-by', 'Uma', '--request', 'find checkout bugs']
    const rpc = client([DONE])
    await expect(run([...argv, '--requested-by-id', 'emp_uma'], rpc)).rejects.toThrow(
      '--requested-by-id needs --requested-by <person>.'
    )
    for (const id of [
      'Uma',
      'emp_',
      'emp_Uma',
      'emp_a-b',
      `emp_${'a'.repeat(65)}`,
      '',
      ' emp_uma'
    ]) {
      await expect(run([...argv, ...asking, '--requested-by-id', id], rpc)).rejects.toThrow(
        '--requested-by-id must match ^emp_[a-z0-9_]{1,64}$.'
      )
    }
    await expect(run([...argv, ...asking, '--requested-by-id'], rpc)).rejects.toThrow(
      '--requested-by-id must match ^emp_[a-z0-9_]{1,64}$.'
    )
    expect(rpc).not.toHaveBeenCalled()
    await run([...argv, ...asking, '--requested-by-id', 'emp_uma'], rpc)
    expect(rpc).toHaveBeenCalledWith(
      LOCAL_WORKFLOW_METHODS.run,
      expect.objectContaining({
        request: expect.objectContaining({
          requestedBy: 'Uma',
          requestedById: 'emp_uma',
          request: 'find checkout bugs'
        })
      }),
      expect.anything()
    )
  })

  it('keeps a caller operation ID and explicit benchmark origin when launching', async () => {
    const operationId = '3f9a1c2e-0000-4000-8000-000000000001'
    const rpc = client([DONE])
    const argv = [
      'workflow',
      'run',
      '--template',
      'discover',
      '--prompt',
      'Find bugs',
      '--no-follow'
    ]
    await run([...argv, '--operation-id', operationId, '--origin', 'benchmark'], rpc, true)
    expect(rpc).toHaveBeenCalledWith(
      LOCAL_WORKFLOW_METHODS.run,
      {
        worktree: 'id:wt-1',
        request: {
          template: 'discover',
          prompt: 'Find bugs',
          operationId,
          origin: 'benchmark',
          runsOn: 'fleet'
        }
      },
      { timeoutMs: 150_000 }
    )
    rpc.mockClear()
    await expect(run([...argv, '--operation-id', 'invalid'], rpc, true)).rejects.toThrow(
      '--operation-id must be a UUID'
    )
    expect(rpc.mock.calls.some(([method]) => method === LOCAL_WORKFLOW_METHODS.run)).toBe(false)
  })

  it('reports a failed run as exactly one JSON document with a nonzero exit code', async () => {
    const failedView = {
      ...DONE,
      state: 'failed',
      error: 'No seat could start.'
    } as LocalWorkflowView
    const before = process.exitCode
    try {
      const done = run(
        ['workflow', 'run', '--template', 'council', '--prompt', 'x'],
        client([failedView]),
        true
      )
      await vi.runAllTimersAsync()
      await expect(done).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
        state: 'failed',
        error: 'No seat could start.'
      })
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = before
    }
  })

  it('gives the run total only when every call reported tokens', async () => {
    const reported = {
      ...DONE,
      calls: DONE.calls.map((entry) => ({ ...entry, tokens: { input: 10, output: 1 } })),
      usage: { ...DONE.usage!, tokens: { kind: 'reported', input: 20, output: 2 } }
    } as LocalWorkflowView
    const done = run(
      ['workflow', 'run', '--template', 'discover', '--prompt', 'x'],
      client([reported]),
      true
    )
    await vi.runAllTimersAsync()
    await done
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as WorkflowRunResult
    expect(printed.usage.tokens).toEqual({ kind: 'reported', input: 20, output: 2 })
    expect(printed.usage.partialTokens).toBeUndefined()
  })

  it('accepts quick-discover and exports its results as single-pass and unverified', async () => {
    const quick = {
      ...DONE,
      calls: [DONE.calls[0], call('report/1', { state: 'completed' })],
      graphRun: {
        spec: {
          template: 'quick-discover',
          steps: [
            { id: 'find', kind: 'do' },
            { id: 'report', kind: 'synthesize' }
          ]
        },
        levels: {},
        steps: [
          {
            id: 'find',
            state: 'done',
            agents: [seat],
            rounds: [
              {
                round: 1,
                state: 'done',
                calls: [],
                notes: [],
                items: [
                  {
                    key: 'k1',
                    title: 'Refund skips tax',
                    detail: 'Trigger: partial refund. Wrong: tax kept. Fix: prorate.',
                    location: 'src/refund.ts:12-18',
                    severity: 'high',
                    repeats: 1,
                    evidence: { status: 'found', line: 12 }
                  }
                ]
              }
            ]
          },
          { id: 'report', state: 'done', agents: [seat], rounds: [] }
        ],
        gaps: [],
        notes: []
      }
    } as unknown as LocalWorkflowView
    const rpc = client([quick])
    const done = run(
      ['workflow', 'run', '--template', 'quick-discover', '--prompt', 'Find bugs'],
      rpc,
      true
    )
    await vi.runAllTimersAsync()
    await done
    expect(rpc).toHaveBeenCalledWith(
      LOCAL_WORKFLOW_METHODS.run,
      expect.objectContaining({
        request: expect.objectContaining({ template: 'quick-discover' })
      }),
      expect.anything()
    )
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as WorkflowRunResult
    expect(printed.results.targets).toEqual([
      {
        step: 'find',
        round: 1,
        key: 'k1',
        title: 'Refund skips tax',
        location: 'src/refund.ts:12-18',
        severity: 'high',
        tally: 'unverified',
        votes: [],
        repeats: 1,
        singlePass: true,
        evidence: 'found',
        detail: 'Trigger: partial refund. Wrong: tax kept. Fix: prorate.'
      }
    ])
  })

  it('exports what the app checked in a run that reads pages, apart from what models wrote', async () => {
    const check = { id: 'W1', mark: 'not-in-page', quote: 'fabricated' }
    const ranking = [{ key: 'k1', rank: 1, why: '[W1] "fabricated"', next: '', webChecks: [check] }]
    const claims = [
      { claim: 'Pay now', status: 'open', evidence: '[W1] "fabricated"', webChecks: [check] }
    ]
    const web = {
      ...DONE,
      result: { ...DONE.result!, appendix: '## Sources\n\n- W1 a\\.example: read' },
      calls: DONE.calls.map((entry) => ({ ...entry, webChecks: [check] })),
      graphRun: { ...DONE.graphRun!, ranking, claims }
    } as LocalWorkflowView
    const done = run(
      ['workflow', 'run', '--template', 'discover', '--prompt', 'x'],
      client([web]),
      true
    )
    await vi.runAllTimersAsync()
    await done
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as WorkflowRunResult
    expect(printed.markdown).toBe('## Findings\n1. Race in queue')
    expect(printed.appendix).toBe('## Sources\n\n- W1 a\\.example: read')
    expect(printed.calls.map((entry) => entry.webChecks)).toEqual([[check], [check]])
    expect(printed.results.ranking).toEqual(ranking)
    expect(printed.results.claims).toEqual(claims)
    // A person reads the app's part first, where nothing in the answer can hide it.
    log.mockClear()
    const shown = run(['workflow', 'run', '--template', 'discover', '--prompt', 'x'], client([web]))
    await vi.runAllTimersAsync()
    await shown
    expect(String(log.mock.calls[0]![0]).startsWith('## Sources')).toBe(true)
  })

  it('reads only a regular prompt file of at most 1 MB', async () => {
    dir = await mkdtemp(join(tmpdir(), 'workflow-run-'))
    await writeFile(join(dir, 'big.md'), 'x'.repeat(1024 * 1024 + 1))
    await writeFile(join(dir, 'exact.md'), 'y'.repeat(1024 * 1024))
    const flags = (file: string) =>
      parse(['workflow', 'run', '--template', 'council', '--prompt-file', file]).flags
    await expect(runRequestFromFlags(flags('big.md'), dir)).rejects.toThrow('larger than 1 MB')
    await expect(runRequestFromFlags(flags('.'), dir)).rejects.toThrow('not a regular file')
    await expect(runRequestFromFlags(flags('none.md'), dir)).rejects.toThrow('no such file')
    await expect(runRequestFromFlags(flags('exact.md'), dir)).rejects.toThrow('--prompt')
  })

  it('prints the report and gaps for a person, and fails with the reason when the run fails', async () => {
    const done = run(['workflow', 'run', '--template', 'discover', '--prompt', 'x'], client([DONE]))
    await vi.runAllTimersAsync()
    await done
    expect(log.mock.calls[0]![0]).toBe(
      '## Findings\n1. Race in queue\n\nGaps:\n- The area src/legacy was not searched.'
    )
    const failed = run(
      ['workflow', 'run', '--template', 'council', '--prompt', 'x'],
      client([{ ...DONE, state: 'failed', error: 'No seat could start.' } as LocalWorkflowView])
    )
    const outcome = expect(failed).rejects.toThrow('No seat could start.')
    await vi.runAllTimersAsync()
    await outcome
  })

  it('reports a run that lost calls as degraded, in the JSON and to a person', async () => {
    const lost =
      'Verify: 12 calls lost. They could not start (usage limit), and no other account or model family could take them.'
    const degraded = {
      ...DONE,
      graphRun: {
        ...DONE.graphRun!,
        gaps: [lost],
        degraded: { lostCalls: 12, steps: ['Verify'] }
      }
    } as LocalWorkflowView
    const json = run(
      ['workflow', 'run', '--template', 'discover', '--prompt', 'x'],
      client([degraded]),
      true
    )
    await vi.runAllTimersAsync()
    await json
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      state: 'completed',
      degraded: { lostCalls: 12, steps: ['Verify'] },
      gaps: [lost]
    })
    const plain = run(
      ['workflow', 'run', '--template', 'discover', '--prompt', 'x'],
      client([degraded])
    )
    await vi.runAllTimersAsync()
    await plain
    expect(process.stderr.write).toHaveBeenCalledWith(
      'The discover workflow completed degraded: it lost 12 calls (Verify) that no other account or model family could take.\n'
    )
    // A run that lost nothing carries no degraded field at all.
    const clean = run(
      ['workflow', 'run', '--template', 'discover', '--prompt', 'x'],
      client([DONE]),
      true
    )
    await vi.runAllTimersAsync()
    await clean
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).not.toHaveProperty('degraded')
  })
})

describe('--focus-finding', () => {
  it('passes the parent reference with quick depth, keeping delivery enabled', async () => {
    const request = await runRequestFromFlags(
      new Map([
        ['template', 'discover'],
        ['prompt', 'Check this finding'],
        ['focus-finding', 'parent-run:3'],
        ['depth', 'quick']
      ]),
      '/work'
    )
    expect(request).toMatchObject({ focusFinding: 'parent-run:3', depth: 'quick' })
    expect(request.skipEarlierRuns).toBeUndefined()
  })
  it.each(['run:0', '../run:1', 'run', 'run:no'])(
    'refuses malformed reference %s before launch',
    async (reference) => {
      await expect(
        runRequestFromFlags(
          new Map([
            ['template', 'discover'],
            ['prompt', 'Check'],
            ['focus-finding', reference]
          ]),
          '/work'
        )
      ).rejects.toThrow(/focus-finding/)
    }
  )
  it('refuses focus on another template', async () => {
    await expect(
      runRequestFromFlags(
        new Map([
          ['template', 'council'],
          ['prompt', 'Check'],
          ['focus-finding', 'run:1']
        ]),
        '/work'
      )
    ).rejects.toThrow(/discover only/)
  })
})
