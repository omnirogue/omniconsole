import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../../../shared/session-manage-types'
import { RemoteSessionHosts } from '../../../session-host-remote/remote-session-hosts'
import {
  pairedMacTransport,
  REMOTE_TEST_PANE,
  remoteTestRuntime,
  resetRemoteTestRuntime
} from '../../../session-host-remote/remote-session-test-fixture'
import { testHostRoot, type TestHostRoot } from '../../../session-host/session-host-test-fixture'
import type { PreparedSessionAction } from './session-manage-support'

const hosts = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../../session-host-remote/remote-session-hosts-runtime', () => ({
  getRemoteSessionHosts: () => hosts.current
}))
// Why: the audit line and toast are the local path's own, covered with it.
vi.mock('./session-manage-support', () => ({
  settleSessionAction: async (
    _context: unknown,
    _prepared: unknown,
    _action: unknown,
    result: unknown
  ) => result
}))

const { remoteSessionAction, remoteSessionAnswer } = await import('./session-manage-remote')

let root: TestHostRoot
beforeEach(() => {
  root = testHostRoot()
  hosts.current = new RemoteSessionHosts({
    connect: async () => pairedMacTransport('laptop'),
    now: () => Date.now()
  })
})
afterEach(() => {
  resetRemoteTestRuntime()
  root.dispose()
})

function prepared(hostId: string): PreparedSessionAction {
  return {
    rows: [],
    row: { hostId } as SessionManageSidebarRow,
    entry: {
      title: 'Release notes',
      paneKey: REMOTE_TEST_PANE,
      tabId: null,
      state: 'waiting-for-yes',
      ask: {
        kind: 'permission',
        text: 'Run the migration?',
        options: [
          { n: 1, label: 'Yes' },
          { n: 2, label: 'No' }
        ],
        fingerprint: 'a'.repeat(64)
      }
    } as unknown as SessionManageEntry,
    source: null,
    agentProcess: null,
    actor: { kind: 'pane', paneKey: 'tab-9:planner', title: 'Planner' }
  }
}

describe('a session-manage control on another computer’s session', () => {
  it('leaves this computer’s own sessions to the local path', async () => {
    await expect(
      remoteSessionAction({} as never, prepared('local'), { action: 'restart', payload: {} }, {})
    ).resolves.toBeNull()
  })

  it('answers with the shape the local path answers, naming the computer that did it', async () => {
    const { executor } = await remoteTestRuntime(root.root)
    const result = await remoteSessionAction(
      {} as never,
      prepared('runtime:studio'),
      { action: 'continue', payload: { answer: { kind: 'yes' } } },
      { request: 'go ahead' }
    )
    expect(result).toMatchObject({
      dryRun: false,
      action: 'continue',
      target: { paneKey: REMOTE_TEST_PANE, title: 'Release notes' },
      summary: 'The computer that runs “Release notes” did it (continue it).'
    })
    expect(executor.dispatched).toHaveLength(1)
  })

  it('reports an answer with the question this Mac saw, the choice, and the delivery', async () => {
    await remoteTestRuntime(root.root)
    const dry = await remoteSessionAnswer(
      {} as never,
      prepared('runtime:studio'),
      {
        action: 'answer',
        payload: { expect: 'a'.repeat(64), answer: { kind: 'choose', choice: 2 } }
      },
      { dryRun: true }
    )
    expect(dry).toMatchObject({
      dryRun: true,
      delivery: 'dry-run',
      chosen: { n: 2, label: 'No', value: '2' },
      ask: { text: 'Run the migration?' },
      summary: 'Would ask the computer that runs “Release notes” to answer its question.'
    })
  })
})
