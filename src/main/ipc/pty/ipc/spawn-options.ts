import { attemptLaunchProvenance } from '../../../launch-ledger/launch-provenance-guard'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  resolveIpcSpawnLaunchCause,
  resolveIpcSpawnLaunchAttribution
} from './spawn-launch-attribution'
import { CLAUDE_AUTH_ENV_VARS } from '../../../claude-accounts/environment'
import { LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS } from '../../../pty/legacy-terminal-shim-dir'
import { CODEX_HOME_ENV_KEYS } from '../host-env/codex-home'
import {
  mergePtyEnvDeletions,
  removeCodexHomeDeletionRequests,
  getInheritedAgentHookEnvKeysToDelete,
  getInheritedClaudeSessionStampEnvKeysToDelete
} from '../host-env/pi-agent'
import { promoteAgentTeamsShimPath, deleteRequestedEnvKeys } from '../host-env/path'
import { beginPtySpawnForWorktree } from '../host-env/fresh-spawn-routing'
import {
  awaitPaneSpawnUnlessCancelled,
  makePaneSpawnReservationKey,
  nextPaneSpawnReservation,
  reservePaneSpawn,
  paneSpawnReservationsByOwnerKey,
  pendingRuntimePaneCreatesByOwnerKey
} from '../pane/spawn-reservation'
import { beginPtySpawnGeometry, restorePtySpawnGeometry } from '../delivery/spawn-geometry'
import { getStartupTerminalColorQueryReplyColors } from '../../terminal-startup-color-query-replies'
import { gatePtySpawnAgentLaunch, isLivePtyReattach } from '../agent-launch-admission-gate'
import type { PtyIpcSpawnState } from './spawn-state'

export async function buildPtyIpcSpawnOptions(
  ctx: PtyIpcSpawnState
): Promise<{ isReattach: true } | null> {
  const args = ctx.args
  ctx.spawnEnv = ctx.preAllocatedHandle
    ? { ...ctx.env, ORCA_TERMINAL_HANDLE: ctx.preAllocatedHandle }
    : ctx.env
  const envToDelete = ctx.claudeAuth?.stripAuthEnv
    ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
    : undefined
  ctx.combinedEnvToDelete = mergePtyEnvDeletions(
    envToDelete,
    args.envToDelete ?? [],
    ctx.agentTeamsEnvToDelete ?? [],
    // Why: disable old hosts without removing ORCA_REAL_* while their Windows shim remains on PATH.
    ctx.isDaemonHostSpawn || args.connectionId ? LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS : [],
    ctx.isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(ctx.spawnEnv) : [],
    getInheritedClaudeSessionStampEnvKeysToDelete(ctx.spawnEnv),
    ctx.skipCodexHomeEnv ? CODEX_HOME_ENV_KEYS : [],
    // Why: the persistent daemon compares its own merged CODEX_HOME pair;
    // main cannot safely decide ownership for a process it may not parent.
    ctx.stripInheritedOrcaCodexHome ? ['ORCA_CODEX_HOME'] : []
  )
  if (ctx.codexResumeHomeSelected) {
    ctx.combinedEnvToDelete = removeCodexHomeDeletionRequests(ctx.combinedEnvToDelete)
  }
  deleteRequestedEnvKeys(ctx.spawnEnv, ctx.combinedEnvToDelete)
  promoteAgentTeamsShimPath(ctx.spawnEnv, ctx.requestedAgentTeamsPath)
  ctx.spawnOptions = {
    cols: args.cols,
    rows: args.rows,
    cwd: ctx.cwd,
    ...(ctx.prevalidatedCwd && !ctx.isDaemonHostSpawn
      ? { prevalidatedCwd: ctx.prevalidatedCwd }
      : {}),
    env: ctx.spawnEnv,
    historyIsolationEnabled: ctx.deps.getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
    ...(ctx.isMintedSessionId ? { isNewSession: true } : {})
  }
  if (!args.connectionId && !ctx.isDaemonHostSpawn) {
    ctx.spawnOptions.codexHomePathOverride = { value: ctx.selectedCodexHomePath }
  }
  if (ctx.combinedEnvToDelete) {
    ctx.spawnOptions.envToDelete = ctx.combinedEnvToDelete
  }
  if (ctx.launchCommand !== undefined) {
    ctx.spawnOptions.command = ctx.launchCommand
  }
  if (args.commandDelivery !== undefined) {
    ctx.spawnOptions.commandDelivery = args.commandDelivery
  }
  if (args.startupCommandDelivery !== undefined) {
    ctx.spawnOptions.startupCommandDelivery = args.startupCommandDelivery
  }
  if (isTuiAgent(args.launchAgent)) {
    ctx.spawnOptions.launchAgent = args.launchAgent
  }
  ctx.launchCause ??= attemptLaunchProvenance(
    'renderer-ipc',
    () =>
      resolveIpcSpawnLaunchCause(
        {
          ...args,
          hasLaunchCommand: Boolean(ctx.launchCommand),
          interruptedAutoContinue: ctx.interruptedAutoContinue
        },
        ctx.deps.store
      ),
    { trigger: 'unknown' as const }
  )
  // Latency telemetry only: labels launch.process_spawn; no decision reads it.
  Object.assign(
    ctx.spawnOptions,
    attemptLaunchProvenance(
      'renderer-ipc',
      () =>
        resolveIpcSpawnLaunchAttribution({
          resolvedCause: ctx.launchCause,
          hasLaunchCommand: ctx.launchCommand !== undefined && ctx.launchCommand !== '',
          interruptedAutoContinue: ctx.interruptedAutoContinue,
          launchTrigger: args.launchTrigger,
          launchVisible: args.launchVisible,
          worktreeId: args.worktreeId,
          tabId: args.tabId
        }),
      {}
    )
  )
  if (args.worktreeId !== undefined) {
    ctx.spawnOptions.worktreeId = args.worktreeId
  }
  if (ctx.reservationPaneKey) {
    ctx.spawnOptions.paneKey = ctx.reservationPaneKey
  }
  if (typeof args.tabId === 'string' && args.tabId.length > 0 && args.tabId.length <= 512) {
    ctx.spawnOptions.tabId = args.tabId
  }
  if (ctx.effectiveSessionId !== undefined) {
    ctx.spawnOptions.sessionId = ctx.effectiveSessionId
  }
  // Why: without this, the Windows daemon path ignores the user's Default Shell preference (LocalPtyProvider already honors it via getWindowsShell()).
  if (ctx.effectiveShellOverride !== undefined) {
    ctx.spawnOptions.shellOverride = ctx.effectiveShellOverride
  }
  ctx.spawnGeometry = beginPtySpawnGeometry(
    ctx.effectiveSessionAppId ?? ctx.effectiveSessionId,
    args,
    ctx.isMintedSessionId && !ctx.preAdoptedStablePane
  )
  if (process.platform === 'win32' && !args.connectionId) {
    // Why: the renderer models PowerShell as one shell family; thread the implementation choice so both PTY paths resolve the same executable.
    ctx.spawnOptions.terminalWindowsWslDistro = ctx.expectedWslDistro
    ctx.spawnOptions.terminalWindowsPowerShellImplementation = ctx.deps.getSettings
      ? (ctx.deps.getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
      : undefined
  }
  const startupTerminalColorQueryReplyColors = getStartupTerminalColorQueryReplyColors(args)
  if (startupTerminalColorQueryReplyColors) {
    ctx.spawnOptions.startupIngress = {
      colors: startupTerminalColorQueryReplyColors,
      deadlineMs: 5_000
    }
  }
  const resolvedPaneSpawnReservationKey = makePaneSpawnReservationKey(
    args.worktreeId,
    args.connectionId,
    ctx.reservationPaneKey
  )
  if (
    ctx.paneSpawnReservationKey &&
    resolvedPaneSpawnReservationKey !== ctx.paneSpawnReservationKey
  ) {
    throw new Error('terminal_pane_identity_changed')
  }
  if (!ctx.paneSpawnReservationKey) {
    ctx.paneSpawnReservationKey = resolvedPaneSpawnReservationKey
    const pendingRuntimeCreateAfterPreflight = ctx.paneSpawnReservationKey
      ? pendingRuntimePaneCreatesByOwnerKey.get(ctx.paneSpawnReservationKey)
      : undefined
    if (pendingRuntimeCreateAfterPreflight) {
      await pendingRuntimeCreateAfterPreflight.promise
    }
    let existingPaneSpawnAfterPreflight = ctx.paneSpawnReservationKey
      ? paneSpawnReservationsByOwnerKey.get(ctx.paneSpawnReservationKey)
      : undefined
    while (existingPaneSpawnAfterPreflight && ctx.paneSpawnReservationKey) {
      const settled = await awaitPaneSpawnUnlessCancelled(existingPaneSpawnAfterPreflight)
      if (settled) {
        const reattach = { ...settled, isReattach: true as const }
        if (ctx.spawnGeometry?.id !== reattach.id) {
          restorePtySpawnGeometry(ctx.spawnGeometry)
        }
        return reattach
      }
      existingPaneSpawnAfterPreflight = nextPaneSpawnReservation(
        ctx.paneSpawnReservationKey,
        existingPaneSpawnAfterPreflight
      )
    }
    ctx.paneSpawnReservation = ctx.paneSpawnReservationKey
      ? reservePaneSpawn(ctx.paneSpawnReservationKey)
      : null
  }
  // Why: before the worktree mutex, so an agent waiting for an app-wide start slot never
  // holds up plain shells; the pane reservation above keeps its own pane serialized.
  await gatePtySpawnAgentLaunch({
    launchCommand: ctx.launchCommand,
    launchAgent: args.launchAgent,
    resumeProviderSession: args.resumeProviderSession,
    interruptedRestore: args.interruptedRestore,
    // Why only 'person': the explicit lane is for main's own runtime callers (CLI, orchestration);
    // a renderer start is either a person's or a background restore.
    launchPriority: args.launchPriority === 'person' ? 'person' : undefined,
    launchAdmissionKey: args.launchAdmissionKey,
    launchAdmissionToken: args.launchAdmissionToken,
    liveReattach: isLivePtyReattach(ctx.provider, ctx.isMintedSessionId, ctx.effectiveSessionAppId),
    getSettings: ctx.deps.getSettings
  })
  ctx.finishTerminalInstall = beginPtySpawnForWorktree(args.worktreeId, ctx.cwd, args.connectionId)
  ctx.initiallyHidden = args.initiallyHidden === true
  // Why: daemon PTYs can emit before spawn() resolves, so the hidden mark must beat byte zero (terminal-query-authority.md §races); other providers are safe with the post-spawn mark below.
  ctx.preSpawnHiddenMarkId =
    ctx.initiallyHidden && ctx.isDaemonHostSpawn && ctx.effectiveSessionAppId !== undefined
      ? ctx.effectiveSessionAppId
      : null
  if (ctx.preSpawnHiddenMarkId !== null) {
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
  }
  const runtime = ctx.deps.runtime
  const acquireWorktreeSpawn = runtime?.acquireWorktreeTerminalSpawn
  ctx.releaseWorktreeSpawn = acquireWorktreeSpawn
    ? await acquireWorktreeSpawn.call(runtime, args.worktreeId)
    : undefined
  return null
}
