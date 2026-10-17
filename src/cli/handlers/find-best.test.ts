import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { ROOT_HELP_TEXT_PRIMARY } from '../root-help-text-primary'
import { COMMAND_SPECS } from '../specs'
import { LOCAL_WORKFLOW_METHODS } from '../../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../../shared/local-workflow-view'
import { FIND_BEST_HANDLERS, findRequestFromFlags } from './find-best'
import { localWorkflowFindSpec } from '../../shared/local-workflow-find-request'
import { workflowTemplate } from '../../shared/workflow-graph-templates'

const STARTED = {
  worktreeId: 'wt-1',
  conversationId: 'find-tab',
  executionId: '3f9a1c2e-0000-4000-8000-000000000000'
}

function view(state: string, find?: Record<string, unknown>, markdown?: string) {
  return {
    executionId: STARTED.executionId,
    state,
    ...(markdown ? { result: { markdown, sources: [], coverage: [] } } : {}),
    graphRun: find ? { find } : undefined
  } as unknown as LocalWorkflowView
}

const DONE = view(
  'completed',
  {
    stage: 'done',
    pool: 40,
    source: 'generated',
    top: 5,
    overall: [],
    byCriterion: [],
    winner: { key: 'a', title: 'Crumb & Co', detail: '', by: 'Claude' },
    rows: [{ key: 'a', title: 'Crumb & Co', detail: '', by: 'Claude', scores: [], kept: true }],
    saved: {
      folder: '/work/.omni/find',
      files: ['/work/.omni/find/r.md', '/work/.omni/find/r.csv']
    }
  },
  '## Best option: Crumb & Co'
)

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
    if (method === LOCAL_WORKFLOW_METHODS.find) {
      return { result: STARTED, params }
    }
    return { result: shown.length > 1 ? shown.shift() : shown[0] }
  })
}

function run(argv: string[], call: ReturnType<typeof client>, json = false) {
  const parsed = parse(argv)
  return FIND_BEST_HANDLERS[parsed.commandPath.join(' ')]!({
    client: { call, isRemote: false },
    flags: parsed.flags,
    cwd: '/work',
    json
  } as unknown as HandlerContext)
}

let log: ReturnType<typeof vi.spyOn>
let err: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('omni find-best', () => {
  it('builds the same Find spec as the Best of N template, aside from its tab label', () => {
    const routes = ['claude', 'codex', 'grok'] as const
    const request = findRequestFromFlags(parse(['find-best', 'Landing', '--versions', '4']).flags)
    const fromFlags = localWorkflowFindSpec(request, routes, [])
    expect({ ...fromFlags, template: 'best-of-n' }).toEqual(
      workflowTemplate('best-of-n', routes, { count: 4 })
    )
  })

  it('reads what to find and how from its flags, and names a mistake before anything starts', () => {
    expect(
      findRequestFromFlags(
        parse([
          'find-best',
          'Ad hooks',
          '--count',
          '40',
          '--keep',
          '20',
          '--final',
          '3',
          '--rubric',
          'Ad copy',
          '--good',
          '- Short\\n- Honest'
        ]).flags
      )
    ).toEqual({
      prompt: 'Ad hooks',
      count: 40,
      keep: 20,
      top: 3,
      rubric: 'Ad copy',
      good: '- Short\n- Honest'
    })
    expect(findRequestFromFlags(parse(['find-best', 'Landing', '--versions', '4']).flags)).toEqual({
      prompt: 'Landing',
      versions: true,
      count: 4
    })
    expect(() => findRequestFromFlags(parse(['find-best', 'x', '--final', '9']).flags)).toThrow(
      '--final'
    )
    expect(() => findRequestFromFlags(parse(['find-best', 'x', '--keep', 'ten']).flags)).toThrow(
      '--keep takes a whole number.'
    )
    expect(() => findRequestFromFlags(parse(['find-best', 'x', '--versions', '1']).flags)).toThrow(
      '--versions:'
    )
    expect(() =>
      findRequestFromFlags(parse(['find-best', 'x', '--versions', '3']).flags, ['a', 'b'])
    ).toThrow('--list and --versions do not go together')
    expect(ROOT_HELP_TEXT_PRIMARY).toContain('  find-best ')
  })

  it('starts the run in the app, follows it, and prints the report and where the files are', async () => {
    const call = client([
      view('running', { stage: 'screen', pool: 40, source: 'generated', top: 5, overall: [] }),
      view('paused', { stage: 'screen', pool: 40, source: 'generated', top: 5, overall: [] }),
      DONE
    ])
    const done = run(['find-best', 'Name the bakery', '--keep', '20'], call)
    await vi.runAllTimersAsync()
    await done
    expect(call).toHaveBeenCalledWith(
      LOCAL_WORKFLOW_METHODS.find,
      {
        worktree: 'id:wt-1',
        request: {
          prompt: 'Name the bakery',
          keep: 20,
          origin: 'cli',
          operationId: expect.any(String)
        }
      },
      { timeoutMs: 150_000 }
    )
    expect(call).toHaveBeenCalledWith(LOCAL_WORKFLOW_METHODS.show, {
      worktree: 'id:wt-1',
      conversationId: 'find-tab',
      executionId: STARTED.executionId
    })
    expect(err.mock.calls.map((entry: unknown[]) => entry[0])).toContain(
      'JEV is scoring 40 options…\n'
    )
    expect(err.mock.calls.map((entry: unknown[]) => entry[0])).toContain(
      'Paused in the app; following until it is resumed or stopped.\n'
    )
    expect(log.mock.calls[0]![0]).toBe(
      '## Best option: Crumb & Co\n\nSaved: /work/.omni/find/r.md\n       /work/.omni/find/r.csv'
    )
  })

  it('gives a program the report, every row and the saved files as JSON', async () => {
    const done = run(['find-best', 'Name the bakery'], client([DONE]), true)
    await vi.runAllTimersAsync()
    await done
    const printed = JSON.parse(log.mock.calls[0]![0] as string)
    expect(printed).toMatchObject({
      ...STARTED,
      state: 'completed',
      report: '## Best option: Crumb & Co',
      saved: { files: ['/work/.omni/find/r.md', '/work/.omni/find/r.csv'] },
      rows: [{ title: 'Crumb & Co', kept: true }]
    })
  })

  it('fails with the reason when the run fails, and can return as soon as it starts', async () => {
    const failed = run(
      ['find-best', 'x'],
      client([
        view('failed', {
          stage: 'failed',
          reason: 'JEV could not screen the 40 options: no key.',
          pool: 40,
          source: 'generated',
          top: 5,
          overall: []
        })
      ])
    )
    const outcome = expect(failed).rejects.toThrow('JEV could not screen the 40 options: no key.')
    await vi.runAllTimersAsync()
    await outcome
    const call = client([DONE])
    await run(['find-best', 'x', '--no-follow'], call)
    expect(call).not.toHaveBeenCalledWith(LOCAL_WORKFLOW_METHODS.show, expect.anything())
    expect(log.mock.calls.at(-1)![0]).toContain(`run ${STARTED.executionId}`)
  })

  it('reads a list of options from a file, one per line', async () => {
    vi.useRealTimers()
    const folder = await mkdtemp(join(tmpdir(), 'omni-find-list-'))
    try {
      await writeFile(join(folder, 'repos.txt'), 'bullmq\n\n  pg-boss  \ngraphile-worker\n')
      const call = client([DONE])
      await run(
        ['find-best', 'Best queue', '--list', join(folder, 'repos.txt'), '--no-follow'],
        call
      )
      expect(call.mock.calls[1]![1]).toMatchObject({
        request: { items: ['bullmq', 'pg-boss', 'graphile-worker'] }
      })
      await expect(
        run(['find-best', 'x', '--list', join(folder, 'missing.txt')], client([DONE]))
      ).rejects.toThrow('--list: could not read')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('imports a CSV file with one skipped row and carries the receipt into the request', async () => {
    vi.useRealTimers()
    const folder = await mkdtemp(join(tmpdir(), 'omni-find-csv-'))
    try {
      await writeFile(
        join(folder, 'rows.csv'),
        'title,detail\nAlpha,first\n,missing title\nBeta,second\nGamma,third\n'
      )
      const call = client([DONE])
      await run(
        ['find-best', 'Best option', '--file', join(folder, 'rows.csv'), '--no-follow'],
        call
      )
      expect(call.mock.calls[1]![1]).toMatchObject({
        request: {
          items: [
            { title: 'Alpha', detail: 'first' },
            { title: 'Beta', detail: 'second' },
            { title: 'Gamma', detail: 'third' }
          ],
          importReceipt: {
            read: 4,
            imported: 3,
            skipped: [{ line: 2, reason: 'no title' }],
            merged: 0
          }
        }
      })
      expect(err).toHaveBeenCalledWith('Imported 3 options; skipped 1 rows.\n')
      expect(err).toHaveBeenCalledWith(expect.stringContaining('Workflow operation: '))
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
