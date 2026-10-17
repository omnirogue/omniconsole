import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPEATED_FLAG_SEPARATOR, parseArgs } from '../args'
import { RuntimeClientError } from '../runtime-client'

const callMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

// Why: isolate flag-to-RPC mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

const FIELDS = {
  objective: 'Add a --limit flag to the queue summary.',
  owner: 'Run coordinator, for Sal',
  host: 'Mac Studio',
  branch: 'contributor/queue-limit from origin/main-next',
  scope: 'src/cli/handlers/orchestration/**',
  acceptance: 'pnpm tc exits 0',
  evidence: 'Command, host and exit code in REPORT.md'
}

function fieldFlag(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(REPEATED_FLAG_SEPARATOR)
}

async function run(command: string, flags: [string, string | boolean][], cwd = '/tmp/repo') {
  await ORCHESTRATION_HANDLERS[command]!({
    flags: new Map<string, string | boolean>(flags),
    client: { call: callMock },
    cwd,
    json: true
  } as never)
}

describe('orchestration task templates CLI', () => {
  let log: ReturnType<typeof vi.spyOn>
  let scratch: string

  beforeEach(async () => {
    callMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    scratch = await mkdtemp(join(tmpdir(), 'task-template-cli-'))
  })

  afterEach(async () => {
    log.mockRestore()
    await rm(scratch, { recursive: true, force: true })
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  it('creates a task whose spec is the rendered template', async () => {
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_2', status: 'pending' } } })

    await run('orchestration task-create', [
      ['template', 'implement'],
      ['field', fieldFlag(FIELDS)]
    ])

    const [method, params] = callMock.mock.calls[1]!
    expect(method).toBe('orchestration.taskCreate')
    expect(params.spec).toContain('Production task: Implement (template implement@2)')
    expect(params.spec).toContain('## Host\nMac Studio')
    expect(params.spec).toContain('## Acceptance\n- A1. pnpm tc exits 0')
    expect(params.spec).toContain('This task grants no approval.')
    expect(params.taskTitle).toBe('Implement: Add a --limit flag to the queue summary.')
    // The implement task gets a verify task that waits on it and re-runs the same lines.
    const [verifyMethod, verify] = callMock.mock.calls[2]!
    expect(verifyMethod).toBe('orchestration.taskCreate')
    expect(verify.deps).toBe('["task_1"]')
    expect(verify.spec).toContain('Production task: Verify (template verify@2)')
    expect(verify.spec).toContain('## Acceptance\n- A1. pnpm tc exits 0')
    expect(verify.spec).toContain("Its worker's report is a claim, not evidence")
    expect(verify.spec).toContain('## Under verification\nTask task_1')
  })

  it('creates no verify task with --no-verify, and none for other templates', async () => {
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })

    await run('orchestration task-create', [
      ['template', 'implement'],
      ['field', fieldFlag(FIELDS)],
      ['no-verify', true]
    ])

    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it('keys the verify create off the implement request, so one retry recovers both', async () => {
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_2', status: 'pending' } } })

    await run('orchestration task-create', [
      ['template', 'implement'],
      ['field', fieldFlag(FIELDS)],
      ['retry-request', 'request_1']
    ])

    expect(callMock.mock.calls[1]![2]).toMatchObject({ orchestrationRequestId: 'request_1' })
    expect(callMock.mock.calls[2]![2]).toMatchObject({ orchestrationRequestId: 'request_1:verify' })
  })

  it('reports a lost verify answer under the implement request', async () => {
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })
      .mockRejectedValueOnce(
        new RuntimeClientError('runtime_timeout', 'Timed out (request request_1:verify).', {
          orchestrationRequestId: 'request_1:verify',
          originalCommand: ['omni', 'orchestration', 'task-create', '--template', 'implement']
        })
      )

    const failure = await run('orchestration task-create', [
      ['template', 'implement'],
      ['field', fieldFlag(FIELDS)],
      ['retry-request', 'request_1']
    ]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RuntimeClientError)
    const data = (failure as RuntimeClientError).data as { orchestrationRequestId: string }
    expect(data.orchestrationRequestId).toBe('request_1')
    expect((failure as RuntimeClientError).message).not.toContain('request_1:verify')
  })

  it('keeps every repeated --field through the real argument parser', async () => {
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_2', status: 'pending' } } })
    const argv = ['orchestration', 'task-create', '--template', 'implement']
    for (const [key, value] of Object.entries(FIELDS)) {
      argv.push('--field', `${key}=${value}`)
    }
    const parsed = parseArgs(argv)

    await run('orchestration task-create', [...parsed.flags.entries()])

    const params = callMock.mock.calls[1]![1]
    expect(params.spec).toContain('## Owner\nRun coordinator, for Sal')
    expect(params.spec).toContain('## Evidence\nCommand, host and exit code in REPORT.md')
  })

  it('keeps an explicit title and lets a --field correct the fields file', async () => {
    const file = join(scratch, 'fields.json')
    await writeFile(file, JSON.stringify({ ...FIELDS, host: 'mw0002' }))
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'pending' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_2', status: 'pending' } } })

    await run(
      'orchestration task-create',
      [
        ['template', 'implement'],
        ['fields-file', 'fields.json'],
        ['field', 'host=Mac Studio'],
        ['task-title', 'Queue limit']
      ],
      scratch
    )

    const params = callMock.mock.calls[1]![1]
    expect(params.spec).toContain('## Host\nMac Studio')
    expect(params.taskTitle).toBe('Queue limit')
  })

  it('refuses an incomplete template before reaching the runtime', async () => {
    const { owner: _owner, ...withoutOwner } = FIELDS
    await expect(
      run('orchestration task-create', [
        ['template', 'implement'],
        ['field', fieldFlag({ ...withoutOwner, acceptance: 'TBD' })]
      ])
    ).rejects.toThrow(/no task was created[\s\S]*owner: Owner is required[\s\S]*acceptance:/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a release brief without an approval', async () => {
    await expect(
      run('orchestration task-create', [
        ['template', 'release'],
        ['field', fieldFlag({ ...FIELDS, releasePath: 'install:mac of abc1234', rollback: 'x' })]
      ])
    ).rejects.toThrow(/approval: Approval is required/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses mixed or orphaned template flags', async () => {
    await expect(
      run('orchestration task-create', [
        ['template', 'implement'],
        ['spec', 'do work']
      ])
    ).rejects.toThrow('Give --spec or --template, not both.')
    await expect(
      run('orchestration task-create', [
        ['spec', 'do work'],
        ['field', 'owner=Sal']
      ])
    ).rejects.toThrow('need --template')
    await expect(run('orchestration task-create', [['template', 'deploy']])).rejects.toThrow(
      'Unknown task template "deploy"'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('prints the brief without a runtime call on --print-spec', async () => {
    await run('orchestration task-create', [
      ['template', 'implement'],
      ['field', fieldFlag({ ...FIELDS, objective: 'Tighten the SSH permission guard.' })],
      ['print-spec', true]
    ])
    expect(callMock).not.toHaveBeenCalled()
    const printed = JSON.parse(String(log.mock.calls[0]![0]))
    expect(printed.template).toBe('implement')
    expect(printed.reviewTriggers).toEqual(['permissions', 'cross-host'])
  })

  it('lists the templates and shows one with its fields, locally', async () => {
    await run('orchestration task-templates', [])
    const listed = JSON.parse(String(log.mock.calls[0]![0]))
    expect(listed.templates.map((template: { id: string }) => template.id)).toEqual([
      'implement',
      'verify',
      'independent-review',
      'deterministic-qa',
      'release',
      'live-verification'
    ])
    await run('orchestration task-templates', [['template', 'release']])
    const shown = JSON.parse(String(log.mock.calls[1]![0]))
    expect(shown.templates[0].fields.map((entry: { key: string }) => entry.key)).toContain(
      'approval'
    )
    expect(callMock).not.toHaveBeenCalled()
  })
})
