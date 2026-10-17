// #751's reuse paths from an automatic cleanup session: it never reopens a past session, never
// holds a prompt for a busy one, and is refused an assign-by-ref before any unarchive or resume.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_MANAGE_RPC,
  type SessionManageActor
} from '../../../../shared/session-manage-types'
import { manageEntry, sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import { registerUnattendedPane } from '../../../session-manage/session-manage-unattended'
import { configureStewardSwitches } from '../../../session-steward/steward-switches'
import type { RpcContext, RpcMethod } from '../core'

const CLEANUP_PANE = 'tab-7:leaf-1'

const state = vi.hoisted(() => ({
  actor: null as unknown as SessionManageActor,
  hold: vi.fn(),
  resume: vi.fn(),
  mutate: vi.fn(),
  readRows: vi.fn(async () => [])
}))

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/nonexistent'
}))
vi.mock('../../../session-manage/session-pending-deliveries-runtime', () => ({
  getSessionPendingDeliveries: () => ({ hold: state.hold, waitFor: vi.fn(), list: vi.fn() })
}))
vi.mock('../../../session-manage/session-manage-resume', () => ({
  resumeConversation: state.resume
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: state.readRows,
  runtimeDeliveryDeps: vi.fn(),
  showSessionManageNotice: vi.fn()
}))
vi.mock('./session-folders', () => ({ mutateSessionFolders: state.mutate }))
// The caller as its evidence proves it, stamped by the real registry (what `actorFor` does).
vi.mock('./session-manage-support', async () => {
  const { withUnattendedContext } =
    await import('../../../session-manage/session-manage-unattended')
  return {
    actorFor: () => withUnattendedContext(state.actor),
    prepareSessionAction: async () => ({
      rows: [],
      row: sidebarRow({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1' }),
      entry: manageEntry({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', state: 'working' }),
      source: null,
      agentProcess: null,
      actor: withUnattendedContext(state.actor)
    }),
    recordSessionAction: vi.fn(),
    settleSessionAction: vi.fn(),
    withPartialAudit: vi.fn()
  }
})

const { SESSION_MANAGE_REUSE_METHODS } = await import('./session-manage-reuse-methods')
const { assignByRefOnRuntime } = await import('./session-manage-assign-ref-method')

const cleanups: (() => void)[] = []
const context = { runtime: {} } as unknown as RpcContext

function call(name: string, params: unknown): Promise<unknown> {
  const method = SESSION_MANAGE_REUSE_METHODS.find((entry) => entry.name === name) as RpcMethod
  return Promise.resolve(method.handler(method.params!.parse(params), context))
}

beforeEach(() => {
  state.actor = { kind: 'pane', paneKey: CLEANUP_PANE, title: 'Session cleanup' }
  cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
  cleanups.push(registerUnattendedPane(CLEANUP_PANE, { source: 'cleanup-run', runId: 'run-1' }))
})

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
  vi.clearAllMocks()
})

describe('reuse paths from an automatic cleanup session', () => {
  it('never reopens a past session', async () => {
    await expect(call(SESSION_MANAGE_RPC.resume, { ref: 'claude:abc123' })).rejects.toThrow(
      'A steward run cannot reopen a past session; that needs the person. Nothing changed.'
    )
    expect(state.resume).not.toHaveBeenCalled()
  })

  it('never holds a prompt for a busy session', async () => {
    await expect(
      call(SESSION_MANAGE_RPC.continueWhenIdle, {
        target: { paneKey: 'tab-1:leaf-1' },
        text: 'Carry on when you are free.'
      })
    ).rejects.toThrow('A steward run cannot hold a prompt for a busy session')
    expect(state.hold).not.toHaveBeenCalled()
  })

  it('is refused an assign by ref before anything is unarchived or resumed', async () => {
    await expect(
      assignByRefOnRuntime(context, {
        target: { paneKey: 'tab-1:leaf-1' },
        ref: 'claude:abc123',
        task: 'Add the tests',
        reason: 'it owns this work'
      } as never)
    ).rejects.toThrow('A steward run cannot give a session a new task')
    expect(state.mutate).not.toHaveBeenCalled()
    expect(state.resume).not.toHaveBeenCalled()
  })

  it('leaves a person’s own session free to reopen a past one', async () => {
    state.actor = { kind: 'pane', paneKey: 'tab-2:leaf-1', title: 'Manager' }
    state.resume.mockResolvedValueOnce({
      dryRun: true,
      outcome: 'restarted',
      summary: 'Would reopen'
    })
    await expect(
      call(SESSION_MANAGE_RPC.resume, { ref: 'claude:abc123', dryRun: true })
    ).resolves.toMatchObject({ dryRun: true })
    expect(state.resume).toHaveBeenCalledTimes(1)
  })
})
