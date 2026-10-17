import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const interactivePrompt = JSON.stringify({
  ompApproval: { tool: 'bash', toolCallId: 'copy-1', summary: 'cp source.txt receipt.txt' }
})
const pane = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }

function pendingApproval(): AgentHookServer {
  const server = new AgentHookServer()
  server.ingestRemote(
    {
      ...pane,
      source: 'omp',
      hookEventName: 'tool_approval_requested',
      providerSession: { key: 'session_id', id: 'omp-session' },
      payload: {
        state: 'blocked',
        prompt: 'copy the file',
        agentType: 'omp',
        toolName: 'bash',
        interactivePrompt
      }
    },
    'conn-1'
  )
  return server
}

describe('OMP approval while the terminal repaints', () => {
  it.each(['tool_approval_resolved', 'agent_start', 'agent_end'])(
    'keeps the exact approval until the %s lifecycle event',
    (hookEventName) => {
      const server = pendingApproval()
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ isReplay: true }))
      listener.mockClear()
      server.ingestTerminalStatus({
        ...pane,
        connectionId: 'conn-1',
        payload: { state: 'working', prompt: '', agentType: 'omp' }
      })

      expect(listener).not.toHaveBeenCalled()
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'blocked',
        toolName: 'bash',
        interactivePrompt,
        providerSession: { key: 'session_id', id: 'omp-session' }
      })

      server.ingestRemote(
        {
          ...pane,
          source: 'omp',
          hookEventName,
          payload: {
            state: hookEventName === 'agent_end' ? 'done' : 'working',
            prompt: 'copy the file',
            agentType: 'omp'
          }
        },
        'conn-1'
      )
      expect(server.getStatusSnapshot()[0]?.interactivePrompt).toBeUndefined()
      expect(listener).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { connectionId: 'conn-2', agentType: 'omp' as const, state: 'working' as const },
    { connectionId: 'conn-1', agentType: 'claude' as const, state: 'working' as const },
    { connectionId: 'conn-1', agentType: 'omp' as const, state: 'done' as const }
  ])('clears the approval after conflicting terminal evidence without changing hook identity: %j', (next) => {
    const server = pendingApproval()
    server.ingestTerminalStatus({
      ...pane,
      connectionId: next.connectionId,
      payload: { state: next.state, prompt: '', agentType: next.agentType }
    })

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: next.state,
      agentType: 'omp'
    })
    expect(server.getStatusSnapshot()[0]?.interactivePrompt).toBeUndefined()
  })
})
