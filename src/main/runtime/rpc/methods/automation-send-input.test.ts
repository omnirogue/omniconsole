import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { RpcDispatcher } from '../dispatcher'
import { AUTOMATION_METHODS } from './automations'

const INPUT = {
  workspaceId: 'folder:workspace-1',
  paneKey: 'pane-1',
  ptyId: 'pty-1',
  text: '  Review the customer reply.\nKeep the original spacing.  '
}
const OUTPUT_BINDING = {
  automationId: 'automation-1',
  runId: 'run-1',
  token: 'eafcda2d-99e6-4bfa-bccc-fd1d5c5beaa3'
}

function setup(methods = AUTOMATION_METHODS) {
  const sendAutomationInput = vi.fn().mockResolvedValue({
    handle: 'terminal-1',
    accepted: true,
    bytesWritten: INPUT.text.length
  })
  const sendTerminal = vi.fn()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    sendAutomationInput,
    sendTerminal
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods })
  return {
    sendAutomationInput,
    sendTerminal,
    dispatch: (params: unknown) =>
      dispatcher.dispatch({
        id: 'input-1',
        authToken: 'tok',
        method: 'automation.sendInput',
        params
      })
  }
}

describe('automation.sendInput', () => {
  it('forwards exact executor identity and unmodified text to the guarded runtime method', async () => {
    const { dispatch, sendAutomationInput, sendTerminal } = setup()

    await expect(dispatch(INPUT)).resolves.toMatchObject({
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: INPUT.text.length } }
    })

    expect(sendAutomationInput).toHaveBeenCalledExactlyOnceWith(INPUT)
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('forwards an optional host-issued output binding without changing the input', async () => {
    const { dispatch, sendAutomationInput, sendTerminal } = setup()
    const input = { ...INPUT, automationOutputBinding: OUTPUT_BINDING }

    await expect(dispatch(input)).resolves.toMatchObject({ ok: true })
    expect(sendAutomationInput).toHaveBeenCalledExactlyOnceWith(input)
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['non-object', 'token'],
    ['missing automation', { ...OUTPUT_BINDING, automationId: undefined }],
    ['empty automation', { ...OUTPUT_BINDING, automationId: '' }],
    ['oversized automation', { ...OUTPUT_BINDING, automationId: 'a'.repeat(201) }],
    ['missing run', { ...OUTPUT_BINDING, runId: undefined }],
    ['empty run', { ...OUTPUT_BINDING, runId: '' }],
    ['oversized run', { ...OUTPUT_BINDING, runId: 'r'.repeat(201) }],
    ['missing token', { ...OUTPUT_BINDING, token: undefined }],
    ['empty token', { ...OUTPUT_BINDING, token: '' }],
    ['oversized token', { ...OUTPUT_BINDING, token: 't'.repeat(201) }],
    ['non-string token', { ...OUTPUT_BINDING, token: 1 }],
    ['caller-authored authority', { ...OUTPUT_BINDING, processIncarnation: 'forged' }]
  ])('rejects a %s output binding before runtime admission', async (_label, binding) => {
    const { dispatch, sendAutomationInput, sendTerminal } = setup()

    await expect(dispatch({ ...INPUT, automationOutputBinding: binding })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(sendAutomationInput).not.toHaveBeenCalled()
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it.each([
    ['missing workspace', { ...INPUT, workspaceId: undefined }],
    ['empty workspace', { ...INPUT, workspaceId: '' }],
    ['missing pane', { ...INPUT, paneKey: undefined }],
    ['empty pane', { ...INPUT, paneKey: '' }],
    ['missing PTY', { ...INPUT, ptyId: undefined }],
    ['empty PTY', { ...INPUT, ptyId: '' }],
    ['non-string PTY', { ...INPUT, ptyId: 1 }],
    ['missing text', { ...INPUT, text: undefined }],
    ['non-string text', { ...INPUT, text: 1 }],
    ['caller-supplied bypass', { ...INPUT, bypassHubGuard: true }]
  ])('rejects %s before touching the terminal', async (_label, params) => {
    const { dispatch, sendAutomationInput, sendTerminal } = setup()

    await expect(dispatch(params)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })

    expect(sendAutomationInput).not.toHaveBeenCalled()
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('preserves a runtime refusal without retrying a generic terminal write', async () => {
    const { dispatch, sendAutomationInput, sendTerminal } = setup()
    sendAutomationInput.mockRejectedValue(new Error('terminal_handle_stale'))

    await expect(dispatch(INPUT)).resolves.toMatchObject({
      ok: false,
      error: { code: 'terminal_handle_stale' }
    })

    expect(sendAutomationInput).toHaveBeenCalledTimes(1)
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('reports method_not_found on a host without the guarded method', async () => {
    const { dispatch, sendAutomationInput, sendTerminal } = setup(
      AUTOMATION_METHODS.filter((method) => method.name !== 'automation.sendInput')
    )

    await expect(dispatch(INPUT)).resolves.toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })

    expect(sendAutomationInput).not.toHaveBeenCalled()
    expect(sendTerminal).not.toHaveBeenCalled()
  })
})
