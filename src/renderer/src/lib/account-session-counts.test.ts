import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store'
import type { AccountCapacityRow } from '../../../shared/provider-account-capacity'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { countAccountSessions } from './account-session-counts'
import type { SidebarSession } from './sidebar-sessions'

const now = 10_000_000
const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab:${leafId}`
function account(id = 'one', provider: 'codex' | 'claude' = 'codex'): AccountCapacityRow {
  return {
    choiceId: id,
    provider,
    launchEnv: { [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: `/accounts/${id}` }
  } as AccountCapacityRow
}
function fixture() {
  const state = {
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        agentType: 'codex',
        state: 'working',
        updatedAt: now,
        stateStartedAt: now,
        prompt: '',
        stateHistory: []
      }
    },
    agentLaunchConfigByPaneKey: {
      [paneKey]: { launchConfig: { agentEnv: { CODEX_HOME: '/accounts/one' } } }
    },
    sleepingAgentSessionsByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    ptyIdsByTabId: { tab: ['pty'] },
    terminalLayoutsByTabId: { tab: { ptyIdsByLeafId: { [leafId]: 'pty' } } }
  } as unknown as AppState
  const session = {
    paneKey,
    tabId: 'tab',
    agent: 'codex',
    hostId: 'local',
    rowKey: 'row',
    sessionKey: 'session',
    providerSession: { key: 'session_id', id: 'provider-session' }
  } as SidebarSession
  return { state, session }
}
const exact = (active: number, total: number) => ({
  active,
  total,
  unknownActive: false,
  unknownTotal: false
})

describe('account session counts', () => {
  it('counts a working session once and keeps account selection separate', () => {
    const { state, session } = fixture()
    const counts = countAccountSessions(state, [account(), account('two')], [], now, [
      session,
      { ...session, rowKey: 'duplicate' }
    ])
    expect(counts.one).toEqual(exact(1, 1))
    expect(counts.two).toEqual(exact(0, 0))
  })
  it('uses the newest status when a conversation has duplicate views', () => {
    const { state, session } = fixture()
    const newerPane = `new:${leafId}`
    state.agentStatusByPaneKey[newerPane] = {
      ...state.agentStatusByPaneKey[paneKey],
      paneKey: newerPane,
      state: 'done',
      updatedAt: now + 1
    }
    state.agentLaunchConfigByPaneKey[newerPane] = state.agentLaunchConfigByPaneKey[paneKey]
    const newer = { ...session, paneKey: newerPane, tabId: 'new', rowKey: 'new' }
    for (const sessions of [
      [session, newer],
      [newer, session]
    ]) {
      expect(countAccountSessions(state, [account()], [], now, sessions).one).toEqual(exact(0, 1))
    }
  })
  it.each(['done', 'waiting', 'blocked'] as const)('keeps %s in total only', (status) => {
    const { state, session } = fixture()
    state.agentStatusByPaneKey[paneKey].state = status
    expect(countAccountSessions(state, [account()], [], now, [session]).one).toEqual(exact(0, 1))
  })
  it.each([
    { updatedAt: 0 },
    { restoredUnconfirmed: true },
    { workingMode: 'monitoring' }
  ] as Partial<AgentStatusEntry>[])('excludes inactive evidence %j from active', (patch) => {
    const { state, session } = fixture()
    Object.assign(state.agentStatusByPaneKey[paneKey], patch)
    expect(countAccountSessions(state, [account()], [], now, [session]).one).toEqual(exact(0, 1))
  })
  it('does not use a sibling live PTY as evidence for a stopped pane', () => {
    const { state, session } = fixture()
    state.ptyIdsByTabId.tab = ['sibling']
    expect(countAccountSessions(state, [account()], [], now, [session]).one).toEqual(exact(0, 1))
  })
  it('excludes closed, archived, unavailable and remote conversations', () => {
    const { state, session } = fixture()
    for (const patch of [{ tabId: null }, { unavailable: true }, { hostId: 'ssh:other' }]) {
      expect(
        countAccountSessions(state, [account()], [], now, [
          { ...session, ...patch } as SidebarSession
        ]).one
      ).toEqual(exact(0, 0))
    }
    expect(countAccountSessions(state, [account()], ['session'], now, [session]).one).toEqual(
      exact(0, 0)
    )
    state.paneForegroundAgentByPaneKey[paneKey] = { agent: null, shellForeground: true }
    expect(countAccountSessions(state, [account()], [], now, [session]).one).toEqual(exact(0, 0))
  })
  it('marks incomplete attribution instead of putting unknown sessions on the default account', () => {
    const { state, session } = fixture()
    state.agentLaunchConfigByPaneKey = {}
    expect(countAccountSessions(state, [account()], [], now, [session]).one).toEqual({
      active: 0,
      total: 0,
      unknownActive: true,
      unknownTotal: true
    })
  })
  it('uses recorded launch home ahead of an old transcript and respects path boundaries', () => {
    const { state, session } = fixture()
    session.providerSession!.transcriptPath = '/accounts/two/sessions/log.jsonl'
    expect(
      countAccountSessions(state, [account(), account('two')], [], now, [session]).one
    ).toEqual(exact(1, 1))
    state.agentLaunchConfigByPaneKey = {}
    expect(
      countAccountSessions(state, [account(), account('two')], [], now, [session]).two
    ).toEqual(exact(1, 1))
    session.providerSession!.transcriptPath = '/accounts/one-other/sessions/log.jsonl'
    expect(countAccountSessions(state, [account()], [], now, [session]).one.unknownTotal).toBe(true)
  })
  it('counts Claude teams against their captured Claude account', () => {
    const { state, session } = fixture()
    session.agent = 'claude-agent-teams'
    state.agentLaunchConfigByPaneKey[paneKey].launchConfig.agentEnv = {
      CLAUDE_CONFIG_DIR: '/accounts/one'
    }
    expect(countAccountSessions(state, [account('one', 'claude')], [], now, [session]).one).toEqual(
      exact(1, 1)
    )
  })
})
