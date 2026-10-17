import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import { buildSidebarSessions } from './sidebar-sessions'
import { savedOutcomeSourceFixture } from './sidebar-outcome-source-test-fixtures'

describe('saved outcome source session projection', () => {
  it('retains the same source identity after provider exit without a live provider or fabricated status', () => {
    const { source, tab, chain } = savedOutcomeSourceFixture()
    const live = buildSidebarSessions(source, [chain])[0]!
    delete tab.launchAgent
    const before = JSON.stringify(source)
    const [saved] = buildSidebarSessions(source, [chain])
    expect(saved).toMatchObject({
      rowKey: live.rowKey,
      sessionKey: live.sessionKey,
      paneKey: chain.sourcePaneKey,
      agent: 'Agent',
      label: 'Saved recovery result'
    })
    expect(source.agentStatusByPaneKey).toEqual({})
    expect(JSON.stringify(source)).toBe(before)
    expect(buildSidebarSessions(source)).toEqual([])
  })

  it.each(['done', 'cancelled'] as const)('keeps %s saved outcomes readable', (state) => {
    const { source, tab, chain } = savedOutcomeSourceFixture()
    delete tab.launchAgent
    chain.state = state
    expect(buildSidebarSessions(source, [chain])).toHaveLength(1)
  })

  it.each([
    ['another owner', { hostId: 'runtime:other' }],
    ['another placement', { placement: 'runtime:other' }],
    ['missing owner', { hostId: null }],
    ['another workspace', { worktreeId: 'different' }],
    ['another source pane', { sourcePaneKey: 'other' }],
    ['another source row', { sourceRowKey: 'different' }],
    ['legacy chain', { outcomeSet: undefined }]
  ] satisfies [string, Partial<SessionChain>][])(
    'does not retain a source for %s',
    (_label, patch) => {
      const { source, tab, chain } = savedOutcomeSourceFixture()
      delete tab.launchAgent
      expect(buildSidebarSessions(source, [{ ...chain, ...patch }])).toEqual([])
    }
  )

  it('does not recreate a removed terminal or a removed leaf in an existing tab', () => {
    const { source, tab, chain } = savedOutcomeSourceFixture()
    delete tab.launchAgent
    source.terminalLayoutsByTabId[tab.id]!.root = {
      type: 'leaf',
      leafId: '00000000-0000-4000-8000-000000000099'
    }
    expect(buildSidebarSessions(source, [chain])).toEqual([])
    source.tabsByWorktree = {}
    expect(buildSidebarSessions(source, [chain])).toEqual([])
  })

  it('keeps the current provider identity when the same source still has an agent', () => {
    const { source, chain } = savedOutcomeSourceFixture()
    expect(buildSidebarSessions(source, [chain])).toEqual(buildSidebarSessions(source))
  })

  it('preserves the user name when the source provider exits', () => {
    const { source, tab, chain } = savedOutcomeSourceFixture()
    tab.customTitle = 'My named investigation'
    const live = buildSidebarSessions(source, [chain])[0]!
    delete tab.launchAgent
    expect(buildSidebarSessions(source, [chain])[0]!.label).toBe(live.label)
    expect(live.label).toBe('My named investigation')
  })

  it('does not attach a consistently remote-owned chain to the same local pane identifiers', () => {
    const { source, tab, chain } = savedOutcomeSourceFixture()
    delete tab.launchAgent
    chain.hostId = 'runtime:other'
    chain.sourceRowKey = JSON.stringify([chain.hostId, chain.worktreeId, chain.sourcePaneKey])
    expect(buildSidebarSessions(source, [chain])).toEqual([])
  })

  it('retains an exactly owned remote source as unavailable while its host is disconnected', () => {
    const { source, tab, chain } = savedOutcomeSourceFixture()
    delete tab.launchAgent
    chain.hostId = 'runtime:other'
    chain.sourceRowKey = JSON.stringify([chain.hostId, chain.worktreeId, chain.sourcePaneKey])
    source.repos[0]!.executionHostId = 'runtime:other'
    source.worktreesByRepo['repo-a']![0]!.hostId = 'runtime:other'
    expect(buildSidebarSessions(source, [chain])).toMatchObject([
      { rowKey: chain.sourceRowKey, hostId: chain.hostId, unavailable: true, agent: 'Agent' }
    ])
  })
})
