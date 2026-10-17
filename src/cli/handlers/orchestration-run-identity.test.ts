import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getTerminalHandle = vi.hoisted(() => vi.fn())
vi.mock('../selectors', () => ({ getTerminalHandle }))
vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_RUN_HANDLERS } from './orchestration/run-handlers'

const call = vi.fn()
const invoke = (command: string, flags = new Map<string, string | boolean>()) =>
  ORCHESTRATION_RUN_HANDLERS[command]({
    flags: new Map([['objective', 'audit'], ['id', 'run_audit'], ...flags]),
    client: { call },
    cwd: '/workspace/audit',
    json: true
  } as never)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
  vi.stubEnv('ORCA_PANE_KEY', '')
  getTerminalHandle.mockResolvedValue('term_unrelated_visible')
  call.mockResolvedValue({ result: { run: { id: 'run_audit', objective: 'audit' } } })
})

afterEach(() => vi.unstubAllEnvs())

describe.each(['orchestration run-create', 'orchestration run-use'])('%s identity', (command) => {
  it('refuses an external caller even when another terminal is active', async () => {
    await expect(invoke(command)).rejects.toMatchObject({ code: 'no_active_sender_terminal' })
    expect(getTerminalHandle).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('uses the explicit sender without borrowing the visible terminal', async () => {
    await invoke(command, new Map([['from', 'term_explicit']]))
    expect(call).toHaveBeenCalledWith(
      expect.stringMatching(/^orchestration\.run(Create|Use)$/),
      expect.objectContaining({ from: 'term_explicit' })
    )
    expect(getTerminalHandle).not.toHaveBeenCalled()
  })

  it('recovers caller identity from its pane when the terminal variable is absent', async () => {
    vi.stubEnv('ORCA_PANE_KEY', 'tab_caller:leaf_caller')
    call.mockResolvedValueOnce({ result: { terminal: { handle: 'term_reminted' } } })
    await invoke(command)
    expect(call).toHaveBeenCalledWith('terminal.resolvePane', {
      paneKey: 'tab_caller:leaf_caller'
    })
    expect(call).toHaveBeenLastCalledWith(
      expect.stringMatching(/^orchestration\.run(Create|Use)$/),
      expect.objectContaining({ from: 'term_reminted' })
    )
    expect(getTerminalHandle).not.toHaveBeenCalled()
  })
})

it('keeps active-terminal convenience for the read-only current-run query', async () => {
  await invoke('orchestration run-current')
  expect(call).toHaveBeenCalledWith('orchestration.runCurrent', { from: 'term_unrelated_visible' })
})
