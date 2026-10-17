import type { AppState } from '@/store'
import { translate } from '@/i18n/i18n'
import { getWorktreeMapFromState } from '@/store/selectors'
import type { CodexPaneRestartStartup } from '@/store/terminals/terminal-state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isForeignMachineCodexPtyId } from '@/lib/codex-pane-selection-lane'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { blocksCodexPaneInput } from '../codex-restart-notice-state'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import { isFreshNonDoneAgentStatus } from '../../../../shared/agent-status-types'
import { checkAgentLaunchPreferences } from '../../../../shared/agent-launch-preference-check'
import {
  findCatalogModel,
  findCatalogOption
} from '../../../../shared/agent-session-option-catalog'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import { resolveAgentLaunchCommand } from '../../../../shared/tui-agent-launch-command'
import {
  quoteStartupArg,
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isCodexResumeRelaunchInFlight } from './codex-resume-relaunch-state'

export type CodexResumeRelaunchRequest = { model: string; effort?: string }

export type CodexResumeRelaunchRefusal =
  | {
      code: 'no-pty' | 'remote' | 'no-thread' | 'working' | 'in-flight' | 'account-restart-pending'
    }
  | { code: 'unsupported-effort'; model: string; effort: string; detail: string }
  | { code: 'plan-failed'; detail: string }

export type CodexResumeRelaunchPlan =
  | {
      ok: true
      startup: CodexPaneRestartStartup
      providerSession: AgentProviderSessionMetadata
      launchCommand: string
    }
  | { ok: false; refusal: CodexResumeRelaunchRefusal }

type PlanState = AppState

function refuse(refusal: CodexResumeRelaunchRefusal): CodexResumeRelaunchPlan {
  return { ok: false, refusal }
}

function findTab(
  state: PlanState,
  terminalTabId: string
): { worktreeId: string; tab: TerminalTab } | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === terminalTabId)
    if (tab) {
      return { worktreeId, tab }
    }
  }
  return null
}

/** Why: the mounted restart primitive respawns through connectPanePty with the
 *  tab's local project runtime (WSL included); an SSH or paired-runtime pane
 *  needs that machine's transport assembly, which only its own launch path has. */
function isRemoteCodexPane(state: PlanState, ptyId: string, worktreeId: string | null): boolean {
  if (isRemoteRuntimePtyId(ptyId) || isForeignMachineCodexPtyId(ptyId)) {
    return true
  }
  if (!worktreeId) {
    return false
  }
  const host = parseExecutionHostId(getWorktreeMapFromState(state).get(worktreeId)?.hostId)
  return (
    (host !== null && host.kind !== 'local') ||
    getRuntimeEnvironmentIdForWorktree(state, worktreeId) !== null
  )
}

/** How long after the restart the resumed SessionStart can still be the row being born. */

/** Why: with no effort requested the launch resolver strips only the flags it inserts,
 *  so a recorded `-c model_reasoning_effort=ultra` would ride onto a model that cannot
 *  take it. Drop it here; when nothing is removed the args stay exactly as recorded. */
function dropRecordedEffortOverride(
  agentArgs: string,
  model: string,
  shell: AgentStartupShell
): string {
  const trimmed = agentArgs.trim()
  const tokenized = trimmed ? tokenizeStartupCommand(trimmed, shell) : null
  if (!tokenized?.ok) {
    return agentArgs // a parse error is the launch resolver's to report
  }
  const remove = (
    findCatalogOption(findCatalogModel(CODEX_SESSION_OPTION_CATALOG, model), 'effort') ??
    CODEX_SESSION_OPTION_CATALOG.unknownModelOptions?.find((option) => option.id === 'effort')
  )?.apply.removeAgentArgs
  const kept = remove?.(tokenized.tokens) ?? tokenized.tokens
  return kept.length === tokenized.tokens.length
    ? agentArgs
    : kept.map((token) => quoteStartupArg(token, shell)).join(' ')
}

export function buildCodexResumeRelaunchStartup(args: {
  state: PlanState
  paneKey: string
  terminalTabId: string
  ptyId: string | null
  isWorking: boolean
  requested: CodexResumeRelaunchRequest
  now?: number
}): CodexResumeRelaunchPlan {
  const { state, paneKey, ptyId, requested } = args
  const now = args.now ?? Date.now()
  if (!ptyId) {
    return refuse({ code: 'no-pty' })
  }
  const located = findTab(state, args.terminalTabId)
  if (isRemoteCodexPane(state, ptyId, located?.worktreeId ?? null)) {
    return refuse({ code: 'remote' })
  }
  if (isCodexResumeRelaunchInFlight(paneKey)) {
    return refuse({ code: 'in-flight' })
  }
  if (
    state.pendingCodexPaneRestartIds[ptyId] ||
    blocksCodexPaneInput(state.codexRestartNoticeByPtyId[ptyId])
  ) {
    return refuse({ code: 'account-restart-pending' })
  }
  const entry = state.agentStatusByPaneKey[paneKey]
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  const providerSession = normalizeAgentProviderSession(
    entry?.providerSession ?? sleeping?.providerSession
  )
  if (!providerSession) {
    return refuse({ code: 'no-thread' })
  }
  if (
    args.isWorking ||
    // Why no post-resume exemption: Codex emits no SessionStart on `resume`, so any
    // fresh non-done row after a relaunch is a real turn (verified live 2026-09-13).
    isFreshNonDoneAgentStatus(entry, now)
  ) {
    return refuse({ code: 'working' })
  }
  const preferences = checkAgentLaunchPreferences('codex', requested)
  if (!preferences.ok) {
    return refuse({
      code: 'unsupported-effort',
      model: requested.model,
      effort: requested.effort ?? '',
      detail: preferences.message
    })
  }
  // Mirrors cold-restore-resume-startup.ts: the registry entry for the live row,
  // else the sleeping record's copy when it names this very thread.
  const launchConfig =
    (entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
    (sleeping?.agent === 'codex' &&
    agentProviderSessionsEqual('codex', sleeping.providerSession, providerSession)
      ? sleeping.launchConfig
      : undefined)
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, located?.worktreeId)
  const target = resolveAgentResumeLaunchTarget({
    projectRuntime,
    connectionId: null,
    executionHostId: null,
    worktreePath: located ? getWorktreeMapFromState(state).get(located.worktreeId)?.path : null,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: located?.tab.shellOverride
  })
  const sessionOptions = {
    model: requested.model,
    ...(requested.effort ? { effort: requested.effort } : {})
  }
  const shell = resolveStartupShell(target.platform, target.shell)
  const recordedAgentArgs =
    launchConfig?.agentArgs ?? resolveTuiAgentLaunchArgs('codex', state.settings?.agentDefaultArgs)
  const launchArgs = {
    agent: 'codex' as const,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    // Why: a model pick that cannot carry the current effort sends no `-c`, so the
    // recorded override must go too or Codex would still resume on it.
    agentArgs: requested.effort
      ? recordedAgentArgs
      : dropRecordedEffortOverride(recordedAgentArgs, requested.model, shell),
    agentEnv:
      launchConfig?.agentEnv ?? resolveTuiAgentLaunchEnv('codex', state.settings?.agentDefaultEnv),
    platform: target.platform,
    shell,
    sessionOptions,
    sessionOptionsOverrideAgentArgs: true
  }
  // Why no agentCommand: buildAgentResumeStartupPlan short-circuits on it and
  // drops sessionOptions, so the recorded command is rebuilt from its args.
  const plan = buildAgentResumeStartupPlan({ ...launchArgs, providerSession })
  if (!plan) {
    const resolved = resolveAgentLaunchCommand(launchArgs)
    return refuse({
      code: 'plan-failed',
      detail: resolved.ok
        ? translate(
            'components.native-chat.composer.relaunchRefusedPlanNotResumable',
            'This agent session cannot be resumed.'
          )
        : resolved.error
    })
  }
  return {
    ok: true,
    providerSession,
    launchCommand: plan.launchCommand,
    startup: {
      command: plan.launchCommand,
      ...(plan.env ? { env: plan.env } : {}),
      launchConfig: plan.launchConfig,
      launchAgent: 'codex',
      startupCommandDelivery: 'shell-ready',
      resumeProviderSession: providerSession,
      launchToken: createBrowserUuid(),
      ...(plan.sessionOptions ? { sessionOptions: plan.sessionOptions } : {})
    }
  }
}
