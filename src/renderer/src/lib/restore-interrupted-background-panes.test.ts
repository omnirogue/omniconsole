// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { installInterruptedBackgroundPaneRestore } from './restore-interrupted-background-panes'
import { emptySessionSidebarView } from './session-sidebar-view'
import { conversationViewKey } from './conversation-view'
import { buildPaneSessions } from './sidebar-sessions'
import {
  addSessionTestRecord,
  addSessionTestTab,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mount
}))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
const record: SleepingAgentSessionRecord = {
  paneKey: 'pane',
  tabId: 'tab',
  worktreeId: 'workspace',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'thread' },
  state: 'working',
  prompt: '',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'quit'
}
beforeEach(() => {
  mount.mockReset()
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  useAppStore.setState({
    workspaceSessionReady: false,
    // Why the default (restore flood guard on): G5 — these 'quit' working panes must keep
    // auto-continuing with the guard on; the guard never gates them.
    settings: {} as never,
    sleepingAgentSessionsByPaneKey: { pane: record },
    tabsByWorktree: { workspace: [{ id: 'tab' }] as never }
  })
})
describe('background interruption restore', () => {
  it('waits for hydration and mounts the preserved tab without navigation', () => {
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    useAppStore.setState({ workspaceSessionReady: true })
    expect(mount).toHaveBeenCalledWith({ worktreeId: 'workspace', tabIds: ['tab'] })
    useAppStore.setState({ workspaceSessionReady: true })
    expect(mount).toHaveBeenCalledTimes(1)
    dispose()
  })
  it.each([
    { ...record, origin: 'worktree-sleep' as const },
    { ...record, connectionId: 'ssh-host' },
    { ...record, restoreOnTabOpenOnly: true },
    { ...record, automaticResumeBlockedBy: 'legacy-orchestration-worker' as const },
    { ...record, state: 'done' as const },
    { ...record, origin: 'live' as const, state: 'done' as const }
  ])('does not undo explicit sleep or claim remote execution %#', (row) => {
    useAppStore.setState({
      workspaceSessionReady: true,
      sleepingAgentSessionsByPaneKey: { pane: row }
    })
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    dispose()
  })
  it("keeps auto-continuing 'quit' and 'live' working panes with the flood guard on or off (G5)", () => {
    for (const settings of [{}, { restoreFloodGuard: true }, { restoreFloodGuard: false }]) {
      mount.mockReset()
      useAppStore.setState({
        workspaceSessionReady: true,
        settings: settings as never,
        sleepingAgentSessionsByPaneKey: {
          pane: record,
          live: { ...record, paneKey: 'live', tabId: 'tab-live', origin: 'live' }
        },
        tabsByWorktree: { workspace: [{ id: 'tab' }, { id: 'tab-live' }] as never }
      })
      const dispose = installInterruptedBackgroundPaneRestore()
      expect(mount.mock.calls).toEqual([
        [{ worktreeId: 'workspace', tabIds: ['tab'] }],
        [{ worktreeId: 'workspace', tabIds: ['tab-live'] }]
      ])
      dispose()
    }
  })
  it('mounts a mid-task pane again when its queued start was dropped because the pane went away', async () => {
    const { noteAgentStartAbandoned, resetAgentStartsInFlightForTests } =
      await import('./agent-start-in-flight')
    resetAgentStartsInFlightForTests()
    useAppStore.setState({ workspaceSessionReady: true })
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).toHaveBeenCalledTimes(1)
    // The pane unmounted while its resume waited for an admission slot; main dropped the start.
    noteAgentStartAbandoned('pane')
    expect(mount).toHaveBeenCalledTimes(2)
    expect(mount).toHaveBeenLastCalledWith({ worktreeId: 'workspace', tabIds: ['tab'] })
    // Another pane's start, or a pane this file never mounted, changes nothing.
    noteAgentStartAbandoned('other-pane')
    expect(mount).toHaveBeenCalledTimes(2)
    // Bounded: a pane that keeps going away is not re-mounted forever.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      noteAgentStartAbandoned('pane')
    }
    expect(mount).toHaveBeenCalledTimes(4)
    dispose()
  })
  it('leaves every restored tab lazy when auto-continue is off', () => {
    useAppStore.setState({
      workspaceSessionReady: true,
      settings: { autoContinueInterruptedSessions: false } as never
    })
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    dispose()
  })
})

describe('background interruption restore leaves put-away panes alone', () => {
  // A real pane row, keyed the way the sidebar keys it, so the archive mark used here is the
  // one the sidebar's Archive action writes.
  function workingPane() {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source, 'tab-a')
    const paneRecord = addSessionTestRecord(source, tab, 'provider-a')
    const working: SleepingAgentSessionRecord = {
      ...paneRecord,
      state: 'working',
      origin: 'quit'
    }
    source.sleepingAgentSessionsByPaneKey = { [working.paneKey]: working }
    useAppStore.setState({ ...source, workspaceSessionReady: true, settings: {} as never } as never)
    const row = buildPaneSessions(useAppStore.getState()).find(
      (session) => session.paneKey === working.paneKey
    )!
    return { working, key: conversationViewKey(row) }
  }
  it('still mounts a working pane the person did not put away', () => {
    workingPane()
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).toHaveBeenCalledTimes(1)
    dispose()
  })
  it.each(['archived', 'hidden', 'deleted'] as const)('skips a %s working pane', (how) => {
    const { key } = workingPane()
    const view = emptySessionSidebarView()
    if (how === 'archived') {
      useSessionSidebarView.setState({ view: { ...view, archived: [key] }, archived: [key] })
    } else if (how === 'hidden') {
      useSessionSidebarView.setState({ view: { ...view, hidden: [`conversation:${key}`] } })
    } else {
      useSessionSidebarView.setState({ view: { ...view, deleted: [key] } })
    }
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    dispose()
  })
  it('tells the restore flood guard which panes are put away, as this file reads it', async () => {
    const { key, working } = workingPane()
    const { decideBackgroundResume } = await import('./restore-flood-resume-verdict')
    // A mid-task 'quit' record: G5 keeps it auto-continuing, so only put-away can hold it (an idle
    // 'quit' checkpoint is held either way).
    const verdict = () =>
      decideBackgroundResume(useAppStore.getState(), {
        paneKey: working.paneKey,
        tabId: working.tabId ?? '',
        record: working,
        visible: false
      })
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(verdict()).toEqual({ hold: false, reason: 'not-guarded' })
    const view = emptySessionSidebarView()
    useSessionSidebarView.setState({ view: { ...view, archived: [key] }, archived: [key] })
    expect(verdict()).toEqual({ hold: true, kind: 'put-away' })
    dispose()
    // Unregistered with the installer: nothing reads as put away.
    expect(verdict()).toEqual({ hold: false, reason: 'not-guarded' })
  })
  // The restore re-runs on every store change, not only at hydration, and a pane's sleeping
  // record is rewritten on each agent status update. So a pane the person archives after
  // load, whose agent later reports working, must stay put away too.
  it('keeps skipping a pane archived after load when the store changes again', () => {
    const { working, key } = workingPane()
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), archived: [key] },
      archived: [key]
    })
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [working.paneKey]: { ...working, updatedAt: working.updatedAt + 1 }
      }
    })
    expect(mount).not.toHaveBeenCalled()
    dispose()
  })
  it('mounts a working pane once even as later store changes re-run the restore', () => {
    const { working } = workingPane()
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).toHaveBeenCalledTimes(1)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [working.paneKey]: { ...working, updatedAt: working.updatedAt + 1 }
      }
    })
    expect(mount).toHaveBeenCalledTimes(1)
    dispose()
  })
  it('does not relaunch anything before the personal view is loaded', () => {
    workingPane()
    const load = vi.fn()
    useSessionSidebarView.setState({ loaded: false, load } as never)
    const dispose = installInterruptedBackgroundPaneRestore()
    expect(mount).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalled()
    dispose()
  })
})
