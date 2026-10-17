import type { AcpJsonRpcConnection } from './acp-jsonrpc-connection'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

export function fakeConnection(script: {
  initialize?: AcpJsonRpcConnection['initialize']
  onRequest?: (method: string, params?: Record<string, unknown>) => unknown
}): AcpJsonRpcConnection & {
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown }[]
  errors: { id: number | string; code: number }[]
} {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const replies: { id: number | string; result?: unknown }[] = []
  const errors: { id: number | string; code: number }[] = []
  return {
    pid: 99,
    closed: false,
    initialize: script.initialize ?? { protocolVersion: 1, authMethods: [] },
    calls,
    replies,
    errors,
    request: async (method, params) => {
      calls.push({ method, params })
      return script.onRequest?.(method, params)
    },
    notify: (method, params) => {
      calls.push({ method, params })
    },
    respond: (id, result) => {
      replies.push({ id, result })
    },
    respondError: (id, code) => {
      errors.push({ id, code })
    },
    close: async () => true
  }
}

export const localLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'ws-1',
  workspaceKind: 'git-worktree' as const
} satisfies AgentSessionExecutionLocation
