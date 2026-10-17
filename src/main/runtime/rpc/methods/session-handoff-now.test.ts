import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { SessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { SESSION_HANDOFF_NOW_METHOD as method } from './session-handoff-now'

const f = vi.hoisted(() => ({
  capture: vi.fn(),
  pane: { handle: 'handle', ptyId: 'pty', worktreeId: 'workspace', executionHostId: 'ssh:owner' },
  workspace: { hostId: 'ssh:owner', path: '/remote/work' }
}))
vi.mock('../../session-handoff-capture', () => ({ captureSshSessionHandoff: f.capture }))
const rule: SessionFollowUpRule = {
  revision: 1,
  taskId: null,
  taskTitle: 'Session',
  sessionLabel: 'Session',
  recipients: [
    { employeeId: 'emp_person', name: 'Person', operationId: 'handoff_op', delivery: 'pending' }
  ],
  deliverables: { kind: 'files', paths: [] },
  includeSummary: true,
  note: 'Continue.',
  savedAt: 1
}
const params = {
  paneKey: 'pane',
  worktreeId: 'workspace',
  expectedConnectionId: 'owner',
  handoff: rule,
  summary: 'Current work'
}
const context = () =>
  ({
    clientId: 'desktop-renderer',
    runtime: {
      resolveTerminalPane: () => ({ ...f.pane }),
      showManagedTerminalWorkspace: async () => ({ ...f.workspace })
    }
  }) as unknown as RpcContext
beforeEach(() => {
  f.capture.mockReset().mockResolvedValue(rule)
  f.pane.executionHostId = 'ssh:owner'
  f.workspace.hostId = 'ssh:owner'
})

it('captures only the pane’s attested SSH workspace with no outcome continuation requirement', async () => {
  expect(await method.handler(method.params!.parse(params), context())).toEqual({ handoff: rule })
  expect(f.capture).toHaveBeenCalledWith(
    rule,
    '/remote/work',
    'Current work',
    'owner',
    expect.any(Function)
  )
})
it.each(['pane', 'workspace'] as const)(
  'refuses a different %s owner before capture',
  async (target) => {
    if (target === 'pane') {
      f.pane.executionHostId = 'local'
    } else {
      f.workspace.hostId = 'local'
    }
    await expect(method.handler(method.params!.parse(params), context())).rejects.toThrow()
    expect(f.capture).not.toHaveBeenCalled()
  }
)
it('checks the owner again while the captured files are being materialized', async () => {
  f.capture.mockImplementation(async (_rule, _path, _summary, _connection, assertOwner) => {
    f.pane.executionHostId = 'ssh:replacement'
    assertOwner()
    return rule
  })
  await expect(method.handler(method.params!.parse(params), context())).rejects.toThrow(
    'execution host changed'
  )
})
it('requires the authenticated user interface before making an immediate capture', async () => {
  await expect(
    method.handler(method.params!.parse(params), { ...context(), clientId: 'agent' })
  ).rejects.toThrow('authenticated user interface')
  expect(f.capture).not.toHaveBeenCalled()
})
