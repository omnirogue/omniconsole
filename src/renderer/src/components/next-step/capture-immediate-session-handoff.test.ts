import { beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { captureImmediateSessionHandoff } from './capture-immediate-session-handoff'

const f = vi.hoisted(() => ({
  call: vi.fn(),
  negotiate: vi.fn(),
  connection: vi.fn(),
  environmentId: 'peer'
}))
vi.mock('@/lib/session-outcome-connection', () => ({
  sessionOutcomeConnection: f.connection
}))
vi.mock('@/lib/conversation-fleet-context-source', () => ({
  resolveConversationFleetSourceRuntimeEnvironment: () => f.environmentId
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  hasRuntimeRpcErrorCode: (error: unknown, code: string) =>
    (error as { code?: string }).code === code
}))
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  hostId: 'ssh:owner',
  paneKey: 'pane',
  tabId: 'tab',
  worktreeId: 'workspace',
  kind: 'terminal',
  label: 'Current work',
  workspaceLabel: 'Remote workspace',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
const rule: SessionFollowUpRule = {
  revision: 1,
  taskId: null,
  taskTitle: 'Current work',
  sessionLabel: 'Current work',
  recipients: [
    { employeeId: 'emp_person', name: 'Person', operationId: 'handoff_op', delivery: 'pending' }
  ],
  deliverables: { kind: 'files', paths: [] },
  includeSummary: true,
  note: 'Continue.',
  savedAt: 1,
  transcriptSource: {
    kind: 'provider',
    hostId: 'ssh:owner',
    runtimeEnvironmentId: 'peer',
    agent: 'codex',
    sessionId: 'source'
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  f.connection.mockReturnValue({ call: f.call, negotiate: f.negotiate })
  f.call.mockResolvedValue({ handoff: rule })
})

it('uses a one-shot capture with the explicit SSH owner instead of negotiating unattended outcomes', async () => {
  expect(await captureImmediateSessionHandoff(session, rule, 'Current work')).toEqual(rule)
  expect(f.connection).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'peer' })
  expect(f.negotiate).not.toHaveBeenCalled()
  expect(f.call).toHaveBeenCalledWith(
    'sessionChain.captureHandoffNow',
    {
      paneKey: 'pane',
      worktreeId: 'workspace',
      expectedConnectionId: 'owner',
      summary: 'Current work',
      handoff: {
        ...rule,
        transcriptSource: {
          kind: 'provider',
          hostId: 'ssh:owner',
          agent: 'codex',
          sessionId: 'source'
        }
      }
    },
    { timeoutMs: 60_000 }
  )
})
it('refuses another runtime’s transcript without making any capture call', async () => {
  await expect(
    captureImmediateSessionHandoff(
      session,
      {
        ...rule,
        transcriptSource: { ...rule.transcriptSource!, runtimeEnvironmentId: 'different-peer' }
      },
      'Current work'
    )
  ).rejects.toThrow('does not own')
  expect(f.call).not.toHaveBeenCalled()
})
it('reports an older peer without falling back to a local or unattended capture', async () => {
  f.call.mockRejectedValue(Object.assign(new Error('Unknown method'), { code: 'method_not_found' }))
  await expect(captureImmediateSessionHandoff(session, rule, 'Current work')).rejects.toThrow(
    'Update the connected OmniConsole runtime'
  )
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(f.negotiate).not.toHaveBeenCalled()
})
