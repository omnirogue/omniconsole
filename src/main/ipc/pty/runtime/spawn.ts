import { attemptLaunchProvenance } from '../../../launch-ledger/launch-provenance-guard'
import { trackLaunchProducer } from '../../../launch-ledger/launch-ledger'
import {
  recordRuntimeSpawnLaunch,
  recordSpawnLaunchFailure
} from '../../../launch-ledger/spawn-launch-record'
import { assertNoLiveSavedConversationOwner } from '../pane/provider-conversation-recovery'
import { carryResumedTaskForSpawn } from '../pane/resume-task-link'
import { toRuntimeSpawnReply } from './spawn-reply'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  reservePaneSpawn
} from '../pane/spawn-reservation'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { restorePtySpawnGeometry } from '../delivery/spawn-geometry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { beginRuntimePtySpawnInstall, buildRuntimePtySpawnOptions } from './spawn-options'
import { executeRuntimePtySpawn } from './spawn-execute'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import { assertUnboundHubTerminalLaunch } from '../../../pty/hub-task-launch-admission'
import { getDeclaredLaunchHubTaskId } from '../pane/launch-authority'
import { resolveNewAgentSessionCommandDefaults } from '../../../runtime/new-agent-session-command-defaults'
import { gatePtySpawnAgentLaunch, isLivePtyReattach } from '../agent-launch-admission-gate'

export function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  return trackLaunchProducer(() => spawnTrackedPtyFromRuntimeController(deps, args))
}

async function spawnTrackedPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  if (
    args.launchGate &&
    (args.connectionId || args.adoptedStablePane || args.agentSessionEnsure || args.sessionId)
  ) {
    throw new Error('pty_launch_gate_requires_fresh_local_process')
  }
  const ctx = createRuntimePtySpawnState(deps, args)
  if (!args.adoptedStablePane) {
    const leafId =
      typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
    const paneKey =
      typeof args.worktreeId === 'string' &&
      typeof args.tabId === 'string' &&
      isValidTerminalTabId(args.tabId) &&
      args.tabId.length <= 512 &&
      leafId
        ? makePaneKey(args.tabId, leafId)
        : null
    const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
    const existingOwner = paneKey
      ? resolveStablePaneOwner(
          deps.runtime,
          deps.store,
          paneKey,
          args.worktreeId,
          args.connectionId
        )
      : null
    // Why: reject known fresh Hub launches before reservations or managed-auth preparation.
    if (
      !existingOwner &&
      !args.agentSessionEnsure &&
      (!args.sessionId || args.isNewSession === true) &&
      (!ownerKey || !paneSpawnReservationsByOwnerKey.has(ownerKey))
    ) {
      assertUnboundHubTerminalLaunch({
        env: args.env,
        hubTaskId: getDeclaredLaunchHubTaskId(deps.store, args.worktreeId, args.launchAgent),
        launchGate: args.launchGate,
        worktreeId: args.worktreeId
      })
    }
    if (ownerKey && !existingOwner && !paneSpawnReservationsByOwnerKey.has(ownerKey)) {
      ctx.paneSpawnReservationKey = ownerKey
      ctx.paneSpawnReservation = reservePaneSpawn(ownerKey)
    }
  }
  try {
    const materializedOrPromise = adoptMaterializedRuntimePtySpawn(ctx)
    const materialized =
      materializedOrPromise instanceof Promise ? await materializedOrPromise : materializedOrPromise
    if (materialized) {
      attemptLaunchProvenance(
        'runtime-controller',
        () => recordRuntimeSpawnLaunch(ctx, materialized, true),
        undefined
      )
      return toRuntimeSpawnReply(materialized)
    }
    const earlyAdopt = await prepareRuntimePtySpawn(ctx)
    if (earlyAdopt) {
      attemptLaunchProvenance(
        'runtime-controller',
        () => recordRuntimeSpawnLaunch(ctx, earlyAdopt, true),
        undefined
      )
      return toRuntimeSpawnReply(earlyAdopt)
    }
    const settings = deps.getSettings?.()
    if (settings && ctx.cwd) {
      // Why: a routine resuming its recorded thread in a new pane is a fresh launch for
      // defaults — it takes the persisted model a fresh launch would — unlike an adopted
      // or ensured session, whose command is already resolved.
      const automationThreadResume =
        Boolean(args.resumeProviderSession) && args.launchCause?.trigger === 'automation'
      ctx.launchCommand = await resolveNewAgentSessionCommandDefaults({
        agent: args.launchAgent,
        command: ctx.launchCommand,
        launchConfig: args.launchConfig,
        continuation: Boolean(
          (args.resumeProviderSession && !automationThreadResume) ||
          args.agentSessionEnsure ||
          args.adoptedStablePane ||
          (args.sessionId && !args.isNewSession)
        ),
        threadResume: automationThreadResume,
        settings,
        env: ctx.env,
        accountHome:
          args.launchAgent === 'codex'
            ? (ctx.selectedCodexHomePath ?? undefined)
            : ctx.env?.CLAUDE_CONFIG_DIR,
        workspacePath: ctx.cwd,
        connectionId: args.connectionId
      })
    }
    const earlyReserved = await buildRuntimePtySpawnOptions(ctx).catch((error: unknown) => {
      restorePtySpawnGeometry(ctx.spawnGeometry)
      throw error
    })
    if (earlyReserved) {
      attemptLaunchProvenance(
        'runtime-controller',
        () => recordRuntimeSpawnLaunch(ctx, earlyReserved, true),
        undefined
      )
      return toRuntimeSpawnReply(earlyReserved)
    }
    const savedOwner = ctx.preAdoptedStablePane
      ? undefined
      : assertNoLiveSavedConversationOwner(args, ctx.spawnOptions, deps.store)
    if (savedOwner) {
      await savedOwner
    }
    // Why: CLI, mobile and runtime RPC agent starts share the renderer's app-wide window;
    // gated before the worktree install token (the removal fence) and the worktree spawn mutex,
    // so a queued start holds up neither a worktree deletion nor plain shells. They wait in the
    // explicit lane (ahead of restore sweeps) or the person lane (a phone's own create), carry
    // their pane key so a desktop reveal can promote them and the phone's subscribe can see them
    // queued, and keep their RPC socket alive while they wait. A caller that disconnects (only
    // signal-carrying requests: long-polls and WebSocket clients) would have its spawn refused
    // by the provider anyway (client_disconnected), so its queued start leaves without a slot.
    await gatePtySpawnAgentLaunch({
      launchCommand: ctx.launchCommand,
      launchAgent: args.launchAgent,
      resumeProviderSession: args.resumeProviderSession,
      launchPriority: args.launchPriority ?? 'explicit',
      ...(ctx.spawnIdentityPaneKey ? { launchAdmissionKey: ctx.spawnIdentityPaneKey } : {}),
      liveReattach:
        Boolean(ctx.preAdoptedStablePane || args.adoptedStablePane) ||
        isLivePtyReattach(ctx.provider, ctx.isNewDaemonSession, ctx.effectiveSessionAppId),
      getSettings: deps.getSettings,
      isCancelled: () => args.signal?.aborted === true,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.onAgentLaunchQueued ? { onQueued: args.onAgentLaunchQueued } : {})
    })
    // Why: a queued start can wait many seconds; its caller's authority is rechecked here.
    args.afterAgentLaunchAdmission?.()
    beginRuntimePtySpawnInstall(ctx)
    await executeRuntimePtySpawn(ctx)
    attemptLaunchProvenance(
      'runtime-controller',
      () => recordRuntimeSpawnLaunch(ctx, ctx.result),
      undefined
    )
    const committed = await commitRuntimePtySpawn(ctx)
    await carryResumedTaskForSpawn(
      {
        paneKey: ctx.spawnIdentityPaneKey ?? undefined,
        ptyId: ctx.result.id,
        worktreeId: args.worktreeId,
        agent: args.launchAgent,
        connectionId: args.connectionId ?? null,
        providerSession: ctx.codexResumeLaunch.notifyResumeUnavailable
          ? undefined
          : args.resumeProviderSession
      },
      ctx.result.isReattach
    )
    attemptLaunchProvenance(
      'runtime-controller',
      () =>
        recordRuntimeSpawnLaunch(
          ctx,
          ctx.result,
          Boolean(ctx.preAdoptedStablePane || args.adoptedStablePane)
        ),
      undefined
    )
    return toRuntimeSpawnReply(committed)
  } catch (err) {
    ctx.providerConversationReservation?.release()
    attemptLaunchProvenance('runtime-controller', () => recordSpawnLaunchFailure(ctx), undefined)
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw — spawn
    // failure, persist failure, or a post-spawn helper such as
    // registerPty/rememberPaneKeyForPty/track — must settle it. Otherwise
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
