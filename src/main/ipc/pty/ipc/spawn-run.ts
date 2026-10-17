import { attemptLaunchProvenance } from '../../../launch-ledger/launch-provenance-guard'
import { trackLaunchProducer } from '../../../launch-ledger/launch-ledger'
import {
  recordIpcSpawnLaunch,
  prepareIpcSpawnLaunch,
  recordSpawnLaunchFailure
} from '../../../launch-ledger/spawn-launch-record'
import { assertNoLiveSavedConversationOwner } from '../pane/provider-conversation-recovery'
import { prepareInterruptedResume } from './interrupted-resume'
import { rejectPaneSpawnReservation } from '../pane/spawn-reservation'
import { restorePtySpawnGeometry } from '../delivery/spawn-geometry'
import { beginPtyIpcSpawn } from './spawn-begin'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import {
  isInterruptedAutoContinueLaunch,
  resolveIpcSpawnLaunchCause
} from './spawn-launch-attribution'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { resolveNewAgentSessionCommandDefaults } from '../../../runtime/new-agent-session-command-defaults'

function releaseAbandonedAgentTeamsLeader(ctx: PtyIpcSpawnState): void {
  if (!ctx.agentTeamsLeaderHandle) {
    return
  }
  ctx.deps.runtime?.releaseClaudeAgentTeamsLeaderForHandle?.(ctx.agentTeamsLeaderHandle)
  ctx.agentTeamsLeaderHandle = null
}

export function runPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  return trackLaunchProducer(() => runTrackedPtyIpcSpawn(deps, args))
}

async function runTrackedPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  const continuation = prepareInterruptedResume(deps, args)
  const ctx = createPtyIpcSpawnState(deps, args)
  // Latency telemetry only: labels launch.process_spawn; nothing branches on it.
  ctx.interruptedAutoContinue = isInterruptedAutoContinueLaunch(continuation !== null, deps)
  // Capture the request before asynchronous preparation can expire its main-side hint.
  ctx.launchCause = attemptLaunchProvenance(
    'renderer-ipc',
    () =>
      resolveIpcSpawnLaunchCause(
        {
          ...args,
          hasLaunchCommand: Boolean(args.command),
          interruptedAutoContinue: ctx.interruptedAutoContinue
        },
        ctx.deps.store
      ),
    { trigger: 'unknown' as const }
  )
  try {
    const early = await beginPtyIpcSpawn(ctx)
    if (early) {
      continuation?.dispose()
      attemptLaunchProvenance(
        'renderer-ipc',
        () => recordIpcSpawnLaunch(ctx, early, true),
        undefined
      )
      return early
    }
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    if (!ctx.preAdoptedStablePane && deps.getSettings && ctx.cwd) {
      // Why: a routine resuming its recorded thread in a new pane is a fresh launch for
      // defaults — it takes the persisted model a fresh launch would — unlike a sleeping
      // session waking (sessionId / interruptedRestore), whose command is already resolved.
      const automationThreadResume =
        Boolean(args.resumeProviderSession) && args.launchTrigger === 'automation'
      ctx.launchCommand = await resolveNewAgentSessionCommandDefaults({
        agent: args.launchAgent,
        command: ctx.launchCommand,
        launchConfig: args.launchConfig,
        continuation: Boolean(
          (args.resumeProviderSession && !automationThreadResume) ||
          args.sessionId ||
          args.interruptedRestore
        ),
        threadResume: automationThreadResume,
        settings: deps.getSettings(),
        env: ctx.env,
        accountHome:
          args.launchAgent === 'codex'
            ? (ctx.selectedCodexHomePath ?? undefined)
            : ctx.env?.CLAUDE_CONFIG_DIR,
        workspacePath: ctx.cwd,
        connectionId: args.connectionId
      })
      ctx.spawnTiming.mark('new_session_defaults')
    }
    const earlyReserved = await buildPtyIpcSpawnOptions(ctx).catch((error: unknown) => {
      restorePtySpawnGeometry(ctx.spawnGeometry)
      throw error
    })
    if (earlyReserved) {
      // Why: this request lost the pane to the reservation winner, so its
      // pre-allocated leader handle never binds to a PTY. Nothing else can
      // evict the team env assembly created for it — exit/close cleanup keys
      // off handleByPtyId — so every lost race would leak one team forever.
      releaseAbandonedAgentTeamsLeader(ctx)
      continuation?.dispose()
      attemptLaunchProvenance(
        'renderer-ipc',
        () => recordIpcSpawnLaunch(ctx, earlyReserved, true),
        undefined
      )
      return earlyReserved
    }
    const savedOwner = ctx.preAdoptedStablePane
      ? undefined
      : assertNoLiveSavedConversationOwner(args, ctx.spawnOptions, deps.store)
    if (savedOwner) {
      await savedOwner
    }
    attemptLaunchProvenance('renderer-ipc', () => prepareIpcSpawnLaunch(ctx), undefined)
    await executePtyIpcSpawn(ctx)
    attemptLaunchProvenance('renderer-ipc', () => recordIpcSpawnLaunch(ctx, ctx.result), undefined)
    const result = await commitPtyIpcSpawn(ctx)
    continuation?.commit(
      result.id,
      !result.isReattach &&
        !result.exitedBeforeSpawnReply &&
        !ctx.codexResumeLaunch.notifyResumeUnavailable
    )
    attemptLaunchProvenance(
      'renderer-ipc',
      () => recordIpcSpawnLaunch(ctx, result, Boolean(ctx.preAdoptedStablePane)),
      undefined
    )
    return result
  } catch (err) {
    ctx.providerConversationReservation?.release()
    attemptLaunchProvenance('renderer-ipc', () => recordSpawnLaunchFailure(ctx), undefined)
    continuation?.dispose()
    releaseAbandonedAgentTeamsLeader(ctx)
    if (ctx.preSpawnHiddenMarkId !== null) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw —
    // spawn failure, persist failure, or a post-spawn helper such as
    // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
    // it lingers in paneSpawnReservationsByOwnerKey and every future spawn
    // for this pane awaits a promise that never resolves. reject is a
    // no-op once the reservation has already resolved.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
