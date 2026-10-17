import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { sessionsOutsideFleet } from '@/lib/conversation-fleet-sidebar'
import {
  effectiveSessionHostFilter,
  legacySessionHostScope,
  sessionAsksByHost,
  sessionCountsByHost,
  sessionsInHostFilter,
  unknownHostSessionCount,
  type SessionHostFilter
} from '@/lib/session-host-scope'
import { onlySessionHostFilter, sameSessionHostFilter } from '@/lib/session-host-switch'
import type { SessionSidebarTreeInput } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import { useLaunchContext } from './new-conversation/launch-context'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { sshTargetIdsWithWorkspace } from '../sidebar-host-options'
import { useSidebarHostScopeOptions } from '../use-sidebar-host-scope-options'
import { sessionHostOptions } from './session-host-options'
import { projectWorkflowExecutionHosts } from '@/lib/workflow-execution-hosts'
import { showsSessionRowHosts } from '@/lib/session-row-host'
import { useSessionRowHosts } from './use-session-row-host-label'
import {
  backgroundTerminalsOutsideSidebar,
  useBackgroundRuntimeTerminals,
  withBackgroundTerminalCounts
} from './background-runtime-terminals'
// Why re-exported here: SessionSidebar sits at its line budget, and the publisher reads this hook's result.
export { usePublishSidebarCounts } from './rendered-sidebar-counts'

const NO_LABELS = new Map<string, string>()
const NO_ENVIRONMENTS: never[] = []
const NO_REPOS: never[] = []
const NO_ASKS = new Map<ExecutionHostId, number>()

/**
 * The Sessions list's host switch: Home (this computer, the default), paired runtimes and SSH
 * hosts, any mix of them, chosen per device. Returns the sessions and fleet runs in the filter,
 * without the sessions a fleet run stands in for, and the switch's props.
 */
export function useSessionHostScope(
  sessions: readonly SidebarSession[],
  fleetRuns: readonly ConversationFleetView[],
  snapshot?: SessionSidebarTreeInput['snapshot']
) {
  const savedFilter = useSessionSidebarView((state) => state.view.hostFilter)
  const savedScope = useSessionSidebarView((state) => state.view.hostScope)
  const saveHostFilter = useSessionSidebarView((state) => state.setHostFilter)
  const environmentId = useAppStore((state) => state.settings?.activeRuntimeEnvironmentId)
  const activeHostId: ExecutionHostId = environmentId
    ? `runtime:${encodeURIComponent(environmentId)}`
    : 'local'
  const { hostOptions: configured } = useSidebarHostScopeOptions()
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels) ?? NO_LABELS
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments) ?? NO_ENVIRONMENTS
  const repos = useAppStore((state) => state.repos) ?? NO_REPOS
  const locatedSessions = useMemo(
    () => projectWorkflowExecutionHosts(sessions, configured, sshTargetLabels),
    [sessions, configured, sshTargetLabels]
  )
  const withWorkspace = useMemo(() => sshTargetIdsWithWorkspace(repos), [repos])
  const { hosts: hostOptions, sshWithoutWorkspace } = useMemo(
    () =>
      sessionHostOptions(
        configured,
        locatedSessions,
        { sshTargetLabels, runtimeEnvironments },
        withWorkspace
      ),
    [configured, locatedSessions, sshTargetLabels, runtimeEnvironments, withWorkspace]
  )
  const filter = useMemo(
    () =>
      effectiveSessionHostFilter({ hostFilter: savedFilter, hostScope: savedScope }, hostOptions),
    [savedFilter, savedScope, hostOptions]
  )
  const setHostFilter = useCallback(
    (next: SessionHostFilter) => saveHostFilter(next, legacySessionHostScope(next, hostOptions)),
    [saveHostFilter, hostOptions]
  )
  // Why: a computer pick lands after several round trips; the filter it narrows must be the one
  // in force then, not the one captured when the pick began. Written after render, as a ref must be.
  const latest = useRef({ filter, hostOptions })
  useEffect(() => {
    latest.current = { filter, hostOptions }
  })
  const selectHost = useCallback(
    async (hostId: ExecutionHostId) => {
      const host = parseExecutionHostId(hostId)
      if (!host || host.kind === 'ssh') {
        return false
      }
      const viewAtStart = useSessionSidebarView.getState().view.hostFilter
      const switched = await useAppStore
        .getState()
        .setActiveRuntimeEnvironmentPreference(host.kind === 'runtime' ? host.environmentId : null)
      if (!switched) {
        return false
      }
      await useAppStore.getState().fetchFolderWorkspaces()
      if (
        (useAppStore.getState().settings?.activeRuntimeEnvironmentId ?? null) !==
        (host.kind === 'runtime' ? host.environmentId : null)
      ) {
        return false
      }
      useLaunchContext.getState().setTarget(undefined)
      // Why: Home writes its view at once and a Globe or plug click can land while the switch is
      // in flight; a view the person has moved since this pick began is theirs, not undone here.
      // Compared by what it shows: another pick landing with the same view is not a move.
      if (!sameSessionHostFilter(useSessionSidebarView.getState().view.hostFilter, viewAtStart)) {
        return true
      }
      setHostFilter(
        onlySessionHostFilter(latest.current.filter, hostId, latest.current.hostOptions)
      )
      return true
    },
    [setHostFilter]
  )
  // Why: a process running in the background on a host is that host's, counted where it is shown
  // and only once: a pane a sidebar row already shows is that row.
  const backgroundTerminals = useBackgroundRuntimeTerminals((state) => state.terminals)
  const sidebarPaneKeys = useMemo(
    () =>
      new Set(
        locatedSessions.flatMap((session) => (session.paneKey ? [session.paneKey] : []))
      ) as ReadonlySet<string>,
    [locatedSessions]
  )
  const sessionCounts = useMemo(
    () =>
      withBackgroundTerminalCounts(
        sessionCountsByHost(locatedSessions),
        backgroundTerminalsOutsideSidebar(backgroundTerminals, sidebarPaneKeys)
      ),
    [locatedSessions, backgroundTerminals, sidebarPaneKeys]
  )
  const unknownHostCount = useMemo(
    () => unknownHostSessionCount(locatedSessions),
    [locatedSessions]
  )
  useEffect(() => {
    useBackgroundRuntimeTerminals.setState({ hostFilter: filter, sidebarPaneKeys })
  }, [filter, sidebarPaneKeys])
  // Why a layout effect: rows name their computer in the same paint the filter mixes computers.
  const rowHostsShown = useMemo(
    () => showsSessionRowHosts(locatedSessions, filter),
    [locatedSessions, filter]
  )
  useLayoutEffect(() => {
    useSessionRowHosts.setState({ shown: rowHostsShown })
  }, [rowHostsShown])
  // Why: counted before the host filter, so a host out of view can still say it needs you.
  const askCounts = useMemo(
    () => (snapshot ? sessionAsksByHost(locatedSessions, snapshot) : NO_ASKS),
    [locatedSessions, snapshot]
  )
  const scoped = useMemo(
    () =>
      sessionsInHostFilter(locatedSessions, fleetRuns, filter, [
        ...hostOptions,
        ...runtimeEnvironments.map((environment) => ({
          id: `runtime:${encodeURIComponent(environment.id)}` as const,
          label: environment.name
        })),
        ...[...sshTargetLabels].map(([id, label]) => ({
          id: `ssh:${encodeURIComponent(id)}` as const,
          label
        }))
      ]),
    [locatedSessions, fleetRuns, filter, hostOptions, runtimeEnvironments, sshTargetLabels]
  )
  const shown = useMemo(
    () => sessionsOutsideFleet(scoped.sessions, scoped.fleetRuns, snapshot),
    [scoped, snapshot]
  )
  return {
    sessions: shown,
    /** The rows `sessionCounts` counted, for the rendered-counts read (session-count step 0). */
    countedSessions: locatedSessions,
    fleetRuns: scoped.fleetRuns,
    bar: {
      filter,
      hostOptions,
      sshWithoutWorkspace,
      sessionCounts,
      unknownHostCount,
      askCounts,
      setHostFilter,
      activeHostId,
      selectHost
    }
  }
}
