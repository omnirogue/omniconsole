import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import {
  isLocalAgentResumeHost,
  resolveAgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../../shared/tui-agent-launch-defaults'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session-resume'
import { pinAgentResumeAccountHome } from '../../../../../shared/agent-resume-account-home'

import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

type AppState = ReturnType<typeof useAppStore.getState>

/** Which provider session a cold restore of this pane would resume, with no side effects.
 *  Shared by the builder and the connect gate (cold-restore-reveal-hold.ts), so both agree on
 *  what "resumable" means. The restore flood guard never makes the builder return null: a null
 *  here makes the deferred attach connect with no command, a bare login shell for every blocked
 *  pane. Blocked panes are held before they connect at all. */
export function resolveColdRestoreResumeTarget(session: ConnectPanePtySession, state: AppState) {
  if (session.pendingStartupCommand || session.isLegacyWorkerAutomaticResumeBlocked()) {
    return null
  }
  const entry = state.agentStatusByPaneKey[session.cacheKey]
  const sleepingRecordEntry = session.getSleepingRecordForPane(state)
  const sleepingRecord = sleepingRecordEntry?.record
  const useLiveEntry = entry && (entry.state !== 'done' || !sleepingRecord)
  const agent = useLiveEntry ? entry.agentType : sleepingRecord?.agent
  if (!agent || !isResumableTuiAgent(agent)) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(
    useLiveEntry ? entry.providerSession : sleepingRecord?.providerSession
  )
  if (!providerSession) {
    return null
  }
  return { agent, providerSession, entry, useLiveEntry, sleepingRecordEntry, sleepingRecord }
}

export function bindBuildColdRestoreAgentResumeStartup(session: ConnectPanePtySession): void {
  session.buildColdRestoreAgentResumeStartup = (): ColdRestoreAgentResumeStartup | null => {
    const state = useAppStore.getState()
    const target = resolveColdRestoreResumeTarget(session, state)
    if (!target) {
      return null
    }
    const { agent, providerSession, entry, useLiveEntry, sleepingRecordEntry, sleepingRecord } =
      target
    // Why: a caller-supplied resume of this very thread (the native model/effort
    // relaunch) already carries the flags the person chose; rebuilding the line
    // from the recorded args below would drop them. Adopt it verbatim and keep the
    // cold-restore bookkeeping (launch registry, sleeping-record cleanup, banner).
    const explicit = session.paneStartup
    const explicitSession = normalizeAgentProviderSession(explicit?.resumeProviderSession)
    if (
      explicit?.command &&
      explicit.launchConfig &&
      explicitSession &&
      agentProviderSessionsEqual(agent, explicitSession, providerSession)
    ) {
      const explicitLaunchToken = explicit.launchToken ?? createBrowserUuid()
      return {
        agent,
        command: explicit.command,
        env: { ...explicit.env, ORCA_AGENT_LAUNCH_TOKEN: explicitLaunchToken },
        launchConfig: explicit.launchConfig,
        resumeProviderSession: providerSession,
        launchToken: explicitLaunchToken,
        useLiveEntry: Boolean(useLiveEntry),
        hasSleepingRecord: Boolean(sleepingRecord),
        sleepingRecordEntry
      }
    }
    const matchingSleepingLaunchConfig =
      sleepingRecord?.launchConfig &&
      (!useLiveEntry ||
        (sleepingRecord.agent === agent &&
          agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)))
        ? sleepingRecord.launchConfig
        : undefined
    const launchConfig =
      (useLiveEntry && entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
      matchingSleepingLaunchConfig
    // Why: the resume line is typed into this pane's live shell, so its quoting must
    // follow the tab's effective Windows shell, not the win32 PowerShell default.
    const resumeTargetArgs = {
      projectRuntime: session.projectRuntime,
      connectionId: session.connectionId,
      executionHostId: session.executionHostId,
      worktreePath: session.worktree?.path,
      terminalWindowsShell: state.settings?.terminalWindowsShell,
      tabShellOverride: session.shellOverride
    }
    const resumeTarget = resolveAgentResumeLaunchTarget(resumeTargetArgs)
    const planArgs = {
      agent,
      providerSession,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      agentArgs:
        launchConfig !== undefined
          ? launchConfig.agentArgs
          : resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs),
      agentEnv:
        launchConfig !== undefined
          ? launchConfig.agentEnv
          : resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv),
      ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
      ...(launchConfig?.ompResumeFilePath
        ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
        : {}),
      platform: resumeTarget.platform,
      shell: resumeTarget.shell
    }
    const startupPlan = buildAgentResumeStartupPlan(
      isLocalAgentResumeHost(resumeTargetArgs) ? pinAgentResumeAccountHome(planArgs) : planArgs
    )
    if (!startupPlan) {
      return null
    }
    const coldRestoreLaunchToken = createBrowserUuid()
    // Why: cold restore means the PTY process is gone but the agent provider
    // session is still resumable, so the replacement spawn must launch it.
    return {
      agent,
      command: startupPlan.launchCommand,
      env: {
        ...startupPlan.env,
        ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken
      },
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: providerSession,
      launchToken: coldRestoreLaunchToken,
      useLiveEntry: Boolean(useLiveEntry),
      hasSleepingRecord: Boolean(sleepingRecord),
      sleepingRecordEntry
    }
  }
}
