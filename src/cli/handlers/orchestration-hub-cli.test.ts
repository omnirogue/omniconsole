import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import { ORCHESTRATION_COMMAND_SPECS } from '../specs/orchestration'
import { ORCHESTRATION_HANDLERS } from './orchestration'

vi.mock('../format', () => ({ printResult: vi.fn() }))

describe('hub execution CLI admission', () => {
  const call = vi.fn()

  beforeEach(() => {
    call.mockReset().mockResolvedValue({ result: {} })
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
  })
  afterEach(() => vi.unstubAllEnvs())

  async function invoke(argv: string[]) {
    const parsed = parseArgs(argv)
    validateCommandAndFlags(ORCHESTRATION_COMMAND_SPECS, parsed)
    return ORCHESTRATION_HANDLERS[parsed.commandPath.join(' ')]({
      flags: parsed.flags,
      client: { call },
      cwd: '/tmp/repo',
      json: true
    } as never)
  }

  it('accepts explicit card admission and revision zero through the public parser', async () => {
    await invoke([
      'orchestration',
      'run-create',
      '--objective',
      'Prepare content',
      '--hub-task-id',
      'btk_content',
      '--hub-state-revision',
      '0'
    ])
    expect(call).toHaveBeenCalledWith('orchestration.runCreate', {
      objective: 'Prepare content',
      from: 'term_coord',
      hubTaskId: 'btk_content',
      hubStateRevision: 0
    })
  })

  it('accepts the execution scope needed by a bound local worker step', async () => {
    await invoke([
      'orchestration',
      'gate-create',
      '--task',
      'task_step',
      '--question',
      'Wait for worker input',
      '--decision-scope',
      'execution'
    ])
    expect(call).toHaveBeenCalledWith('orchestration.gateCreate', {
      task: 'task_step',
      question: 'Wait for worker input',
      decisionScope: 'execution',
      options: undefined,
      from: 'term_coord'
    })
  })

  it('routes a business gate away from the local runtime before any mutation', async () => {
    await expect(
      invoke([
        'orchestration',
        'gate-create',
        '--task',
        'task_step',
        '--question',
        'Publish content',
        '--decision-scope',
        'business'
      ])
    ).rejects.toThrow('Business decisions belong to omnios')
    expect(call).not.toHaveBeenCalled()
  })
})
