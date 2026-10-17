import { describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

const APPROVAL_REQUEST = {
  toolName: 'bash',
  reason: 'tools.approval.bash: prompt',
  approvalMode: 'prompt'
}

async function readApproval(harness: AgentStatusExtensionHarness, toolCallId: string) {
  const read = () => JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload
  await vi.waitFor(() =>
    expect(read()).toMatchObject({
      hook_event_name: 'tool_approval_requested',
      tool_call_id: toolCallId
    })
  )
  return read()
}

describe('OMP approval forwarding', () => {
  it.each([
    ['configured OMP', { kind: 'omp' as const }],
    ['title-routed OMP', { kind: 'pi' as const, title: 'omp' }],
    ['argv-routed OMP', { kind: 'pi' as const, argv: ['node', '/usr/local/bin/omp'] }]
  ])('posts tool_approval_requested and resolved from %s', async (_name, args) => {
    const harness = createAgentStatusExtensionHarness(args)

    expect(harness.handlers.tool_approval_requested).toBeTypeOf('function')
    expect(harness.handlers.tool_approval_resolved).toBeTypeOf('function')

    await harness.callHook('tool_approval_requested', APPROVAL_REQUEST)
    await harness.callHook('tool_approval_resolved', { toolName: 'bash', approved: true })

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/omp')
    expect(
      harness.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).payload)
    ).toEqual([
      {
        hook_event_name: 'tool_approval_requested',
        tool_name: 'bash',
        reason: 'tools.approval.bash: prompt',
        approval_mode: 'prompt'
      },
      {
        hook_event_name: 'tool_approval_resolved',
        tool_name: 'bash',
        approved: true
      }
    ])
  })

  it('does not post OMP approval events from a genuine Pi process', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })

    expect(harness.handlers.tool_approval_requested).toBeTypeOf('function')
    await harness.callHook('tool_approval_requested', APPROVAL_REQUEST)
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('does not register OMP approval handlers on Prime', () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'prime-agent' })

    expect(harness.handlers.tool_approval_requested).toBeUndefined()
    expect(harness.handlers.tool_approval_resolved).toBeUndefined()
  })

  it('correlates an approval with its final scheduled input, not another proposal', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('tool_call', {
      toolCallId: 'call-a',
      toolName: 'bash',
      input: { command: 'original command' }
    })
    await harness.callHook('tool_execution_start', {
      toolCallId: 'call-a',
      toolName: 'bash',
      args: { command: 'revised command' }
    })
    await harness.callHook('tool_execution_start', {
      toolCallId: 'call-b',
      toolName: 'bash',
      args: { command: 'different command' }
    })
    await harness.callHook('tool_approval_requested', { ...APPROVAL_REQUEST, toolCallId: 'call-a' })
    const payload = await readApproval(harness, 'call-a')
    expect(payload).toMatchObject({
      tool_call_id: 'call-a',
      tool_name: 'bash',
      tool_input: { command: 'revised command' }
    })
  })

  it.each(['tool_approval_resolved', 'tool_execution_end', 'agent_start'])(
    'forgets captured input after %s',
    async (eventName) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      await harness.callHook('tool_execution_start', {
        toolCallId: 'call-a',
        toolName: 'bash',
        args: { command: 'owned command' }
      })
      await harness.callHook(eventName, { toolCallId: 'call-a', toolName: 'bash', approved: false })
      await harness.callHook('tool_approval_requested', {
        ...APPROVAL_REQUEST,
        toolCallId: 'call-a'
      })
      const payload = await readApproval(harness, 'call-a')
      expect(payload.tool_call_id).toBe('call-a')
      expect(payload).not.toHaveProperty('tool_input')
    }
  )

  it('does not reuse an input for a missing or mismatched tool identity', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('tool_execution_start', {
      toolCallId: 'call-a',
      toolName: 'write',
      args: { path: '/tmp/owned' }
    })
    await harness.callHook('tool_approval_requested', { ...APPROVAL_REQUEST, toolCallId: 'call-a' })
    expect(await readApproval(harness, 'call-a')).not.toHaveProperty('tool_input')
    await harness.callHook('tool_approval_requested', {
      ...APPROVAL_REQUEST,
      toolCallId: 'missing'
    })
    expect(await readApproval(harness, 'missing')).not.toHaveProperty('tool_input')
  })

  it('bounds retained unapproved inputs instead of carrying an unbounded session history', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    for (let index = 0; index < 129; index += 1) {
      await harness.callHook('tool_execution_start', {
        toolCallId: `call-${index}`,
        toolName: 'bash',
        args: { command: `command-${index}` }
      })
    }
    await harness.callHook('tool_approval_requested', { ...APPROVAL_REQUEST, toolCallId: 'call-0' })
    expect(await readApproval(harness, 'call-0')).not.toHaveProperty('tool_input')
    await harness.callHook('tool_approval_requested', {
      ...APPROVAL_REQUEST,
      toolCallId: 'call-128'
    })
    expect((await readApproval(harness, 'call-128')).tool_input).toEqual({ command: 'command-128' })
  })
})
