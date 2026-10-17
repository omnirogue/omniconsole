// `worker-show` text output must keep "nobody is waiting" apart from "nobody looked".
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { ORCHESTRATION_WORKER_OUTCOME_RECEIPT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

function renderedLine(result: unknown): string {
  const [value, , render] = vi.mocked(printResult).mock.calls[0] as [
    unknown,
    boolean,
    (value: unknown) => string
  ]
  expect(value).toBe(result)
  return render(value)
}

async function showWorker(observation: unknown): Promise<string> {
  const result = {
    dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' },
    worker: { state: 'ready', stage: 'dispatch_input', agent_terminal_handle: 'term_1' },
    ...(observation === undefined ? {} : { observation })
  }
  callMock.mockResolvedValue(result)
  await ORCHESTRATION_HANDLERS['orchestration worker-show']({
    flags: new Map<string, string | boolean>([['dispatch', 'ctx_1']]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  return renderedLine(result)
}

describe('orchestration worker-show interactive wait output', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('names the prompt when a worker is waiting on a human', async () => {
    const line = await showWorker({
      status: 'live',
      exactWorker: true,
      agentWait: { source: 'prompt-text', reason: 'agent-approval-prompt', since: 1 }
    })

    expect(line).toContain('Waiting on a human: agent-approval-prompt (via prompt-text)')
  })

  it('says none when the pane was evaluated and nothing was waiting', async () => {
    const line = await showWorker({ status: 'live', exactWorker: true, agentWait: null })

    expect(line).toContain('Interactive wait: none')
  })

  it('says unknown when the field is absent, not none', async () => {
    // An older host, or a worker whose identity could not be verified. Printing the same
    // thing as an evaluated `null` is the false negative this field exists to remove.
    const line = await showWorker({ status: 'identity_changed', exactWorker: false })

    expect(line).toContain('Interactive wait: unknown (not evaluated)')
    expect(line).not.toContain('Interactive wait: none')
  })

  it('says unknown when the host sent no observation at all', async () => {
    const line = await showWorker(undefined)

    expect(line).toContain('Interactive wait: unknown (not evaluated)')
  })

  it('refuses receipt reads on old hosts before calling ordinary worker-show', async () => {
    callMock.mockResolvedValue({ result: { capabilities: [] } })
    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-show']({
        flags: new Map<string, string | boolean>([
          ['dispatch', 'ctx_1'],
          ['receipt', true]
        ]),
        client: { call: callMock },
        cwd: '/tmp/folder',
        json: true
      } as never)
    ).rejects.toThrow('does not support read-only')
    expect(callMock).toHaveBeenCalledExactlyOnceWith('status.get')
  })

  it('requests the joined receipt and opt-in observation on a supporting host', async () => {
    callMock.mockResolvedValueOnce({
      result: { capabilities: [ORCHESTRATION_WORKER_OUTCOME_RECEIPT_RUNTIME_CAPABILITY] }
    })
    callMock.mockResolvedValueOnce({ receipt: {} })
    await ORCHESTRATION_HANDLERS['orchestration worker-show']({
      flags: new Map<string, string | boolean>([
        ['dispatch', 'ctx_1'],
        ['receipt', true],
        ['observe-provider', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/folder',
      json: true
    } as never)
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.workerShow', {
      dispatch: 'ctx_1',
      receipt: true,
      observeProvider: true
    })
  })

  it.each([
    ['unavailable', 'read_only_attempt_evidence_unavailable'],
    ['not_linked', 'no_hub_task_binding'],
    ['observed', 'canonical_historical_reports_observed']
  ])('renders %s HUB evidence with its reason and unknown quality', async (state, reason) => {
    const result = {
      receipt: {
        binding: { dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_1' },
        status: { dispatch: 'completed' },
        route: { actual: null },
        outcome: {},
        hubEvidence: { state, reason }
      }
    }
    callMock.mockResolvedValueOnce({
      result: { capabilities: [ORCHESTRATION_WORKER_OUTCOME_RECEIPT_RUNTIME_CAPABILITY] }
    })
    callMock.mockResolvedValueOnce(result)
    await ORCHESTRATION_HANDLERS['orchestration worker-show']({
      flags: new Map<string, string | boolean>([
        ['dispatch', 'ctx_1'],
        ['receipt', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/folder',
      json: false
    } as never)
    const line = renderedLine(result)
    expect(line).toContain(`HUB evidence: ${state} (${reason})`)
    expect(line).toContain('independently accepted quality: unknown')
    expect(line).toContain('Provider route: unknown')
    expect(line).toContain('Current acceptance: unknown (not evaluated)')
  })

  it.each([
    [
      {
        state: 'observed',
        authorityView: 'canonical_current_task_verifications',
        reportId: 'ver_report1'
      },
      'accepted report ver_report1 (via canonical_current_task_verifications)'
    ],
    [
      { state: 'unavailable', reason: 'canonical_current_verification_degraded' },
      'unavailable (canonical_current_verification_degraded)'
    ],
    [
      { state: 'not_observed', reason: 'canonical_current_verification_absent' },
      'not_observed (canonical_current_verification_absent)'
    ]
  ])(
    'separates current accepted report evidence from unknown quality: %j',
    async (acceptance, text) => {
      const result = {
        receipt: {
          binding: { dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_1' },
          status: { dispatch: 'completed' },
          route: { actual: null },
          outcome: { currentAcceptance: acceptance },
          hubEvidence: { state: 'observed', reason: 'canonical_historical_reports_observed' }
        }
      }
      callMock.mockResolvedValueOnce({
        result: { capabilities: [ORCHESTRATION_WORKER_OUTCOME_RECEIPT_RUNTIME_CAPABILITY] }
      })
      callMock.mockResolvedValueOnce(result)
      await ORCHESTRATION_HANDLERS['orchestration worker-show']({
        flags: new Map<string, string | boolean>([
          ['dispatch', 'ctx_1'],
          ['receipt', true]
        ]),
        client: { call: callMock },
        cwd: '/tmp/folder',
        json: false
      } as never)
      const line = renderedLine(result)
      expect(line).toContain(`Current acceptance: ${text}`)
      expect(line).toContain('independently accepted quality: unknown')
    }
  )

  it('requires receipt mode before any provider observation request', async () => {
    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-show']({
        flags: new Map<string, string | boolean>([
          ['dispatch', 'ctx_1'],
          ['observe-provider', true]
        ]),
        client: { call: callMock },
        cwd: '/tmp/folder',
        json: true
      } as never)
    ).rejects.toThrow('--observe-provider requires --receipt')
    expect(callMock).not.toHaveBeenCalled()
  })
})
