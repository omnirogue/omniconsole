import { ProviderConversationReservation } from '../pane/provider-conversation-reservation'
import { attemptLaunchProvenance } from '../../../launch-ledger/launch-provenance-guard'
import { prepareRuntimeSpawnLaunch } from '../../../launch-ledger/spawn-launch-record'
import type { PtySpawnResult } from '../../../providers/types'
import { ptyIncarnationById, deletePtyOwnership } from '../provider/ownership-state'
import { restorePtySpawnGeometry } from '../delivery/spawn-geometry'
import { tryGetProviderForAgentSessionOwner } from '../provider/registry'
import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import {
  agentSessionOwners,
  assertSpawnReplyWasLive,
  reconcileAgentSessionOwnerListings
} from '../pane/agent-session-owners'
import { spawnForStablePane, resolveStablePaneOwner } from '../pane/stable-owner'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { isProviderAgentSessionOwnerLive, normalizeNodePtySpawnError } from '../provider/liveness'
import {
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyIdentityMismatchError
} from '../../../providers/ssh-pty-errors'
import type { RuntimePtySpawnState } from './spawn-state'
import { assertUnboundHubTerminalLaunch } from '../../../pty/hub-task-launch-admission'
import { getDeclaredLaunchHubTaskId } from '../pane/launch-authority'

export async function executeRuntimePtySpawn(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  const runtime = ctx.deps.runtime
  const acquireWorktreeSpawn = runtime?.acquireWorktreeTerminalSpawn
  ctx.releaseWorktreeSpawn = acquireWorktreeSpawn
    ? await acquireWorktreeSpawn.call(runtime, args.worktreeId)
    : undefined
  try {
    attemptLaunchProvenance('runtime-controller', () => prepareRuntimeSpawnLaunch(ctx), undefined)
    if (args.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(args.preAllocatedHandle)
    }
    const stablePaneOwnerCandidate = ctx.preAdoptedStablePane
      ? ctx.preAdoptedStablePane.owner
      : args.agentSessionEnsure
        ? null
        : resolveStablePaneOwner(
            ctx.deps.runtime,
            ctx.deps.store,
            ctx.spawnIdentityPaneKey,
            args.worktreeId,
            args.connectionId
          )
    const expectedPtyId =
      stablePaneOwnerCandidate?.ptyId ?? ctx.effectiveSessionAppId ?? ctx.sessionId
    if (expectedPtyId) {
      ctx.deps.runtime?.beginPtyRegistration?.(expectedPtyId)
      ctx.pendingRegistrationPtyId = expectedPtyId
    }
    if (ctx.isDaemonHostSpawn && expectedPtyId) {
      ctx.preparedProvisionalExecutionContext =
        ctx.deps.runtime?.preparePtyExecutionContext?.(expectedPtyId, ctx.expectedWslDistro, {
          resetIncarnation: ctx.isNewDaemonSession && !stablePaneOwnerCandidate,
          preserveExisting: !ctx.isNewDaemonSession || Boolean(stablePaneOwnerCandidate)
        }) ?? false
    }
    const sequenceBeforeProviderSpawn = expectedPtyId
      ? (ctx.deps.runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
      : 0
    const assertClientStillConnected = (): void => {
      if (args.signal?.aborted) {
        throw new Error('client_disconnected')
      }
    }
    if (args.agentSessionEnsure && !ctx.preAdoptedStablePane) {
      // Why: daemon-backed claims can outlive this controller; import owners in scope before declaring absence.
      await reconcileAgentSessionOwnerListings(args.connectionId)
      const recoveredOwner = agentSessionOwners.find(args.agentSessionEnsure.claim)
      if (recoveredOwner && ctx.pendingRegistrationPtyId !== recoveredOwner.ptyId) {
        if (ctx.pendingRegistrationPtyId) {
          ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId)
        }
        ctx.deps.runtime?.beginPtyRegistration?.(
          recoveredOwner.ptyId,
          ptyIncarnationById.get(recoveredOwner.ptyId)
        )
        ctx.pendingRegistrationPtyId = recoveredOwner.ptyId
      }
      let providerResult: PtySpawnResult | null = null
      const ensured = await agentSessionOwners.ensure({
        claim: args.agentSessionEnsure.claim,
        surface: args.agentSessionEnsure.surface,
        spawn: async () => {
          assertClientStillConnected()
          assertUnboundHubTerminalLaunch({
            env: ctx.spawnOptions.env,
            hubTaskId: getDeclaredLaunchHubTaskId(
              ctx.deps.store,
              args.worktreeId,
              args.launchAgent ?? args.agentSessionEnsure?.claim.agent
            )
          })
          ctx.providerConversationReservation = ProviderConversationReservation.acquire(
            args,
            ctx.spawnOptions,
            ctx.provider
          )
          providerResult = await ctx.provider.spawn(ctx.spawnOptions)
          ctx.providerConversationReservation?.bind(ctx.provider, providerResult, args.connectionId)
          ctx.rejectedRegistrationCandidate = providerResult
          // Why: a successful lower-owner return proves physical work committed even if admission sees an early exit.
          ctx.reportPtySpawnCommitted()
          assertSpawnReplyWasLive(providerResult)
          ctx.deps.runtime?.assertPtyRegistrationAllowed?.(
            providerResult.id,
            providerResult.incarnationId
          )
          if (providerResult.incarnationId) {
            // Why: local providers cannot serialize controller claims, so liveness proof
            // needs the exact incarnation before the registry promotes the new owner.
            ptyIncarnationById.set(providerResult.id, providerResult.incarnationId)
          }
          const providerEnsure = providerResult.agentSessionEnsure
          return {
            ptyId: providerResult.id,
            ...(providerEnsure
              ? {
                  owner: providerEnsure.owner,
                  disposition: providerEnsure.disposition
                }
              : {})
          }
        },
        isLive: async (owner) => {
          const ownerProvider = tryGetProviderForAgentSessionOwner(owner.ptyId)
          if (!ownerProvider) {
            // Why: a disconnected relay may keep its PTY alive during the
            // grace window; missing transport is unknown, never absence.
            throw new Error('execution_owner_unavailable')
          }
          return await isProviderAgentSessionOwnerLive(ownerProvider, owner)
        }
      })
      ctx.result = providerResult ?? {
        id: ensured.owner.ptyId,
        isReattach: true,
        // Why: adoption from an authoritative listing must preserve the
        // incarnation proof used to reject a delayed exit from an older process.
        incarnationId: ptyIncarnationById.get(ensured.owner.ptyId)
      }
      ctx.result.agentSessionEnsure = ensured
    } else {
      assertClientStillConnected()
      const stablePaneSpawn = ctx.preAdoptedStablePane
        ? ctx.preAdoptedStablePane
        : await spawnForStablePane({
            runtime: ctx.deps.runtime,
            store: ctx.deps.store,
            provider: ctx.provider,
            spawnOptions: ctx.spawnOptions,
            owner: stablePaneOwnerCandidate,
            worktreeId: args.worktreeId,
            connectionId: args.connectionId,
            resolveOwner: () =>
              resolveStablePaneOwner(
                ctx.deps.runtime,
                ctx.deps.store,
                ctx.spawnIdentityPaneKey,
                args.worktreeId,
                args.connectionId
              ),
            beforeFreshSpawn: (options) => {
              assertUnboundHubTerminalLaunch({
                env: options.env,
                hubTaskId: getDeclaredLaunchHubTaskId(
                  ctx.deps.store,
                  args.worktreeId,
                  options.launchAgent
                ),
                launchGate: options.launchGate,
                worktreeId: args.worktreeId
              })
              ctx.providerConversationReservation = ProviderConversationReservation.acquire(
                args,
                options,
                ctx.provider
              )
            },
            onFreshSpawn: (result) => {
              ctx.providerConversationReservation?.bind(ctx.provider, result, args.connectionId)
              ctx.reportPtySpawnCommitted()
            }
          })
      ctx.result = stablePaneSpawn.result
      ctx.stablePaneOwner = stablePaneSpawn.owner
      if (
        ctx.stablePaneOwner &&
        ctx.isNewDaemonSession &&
        ctx.effectiveSessionAppId &&
        ctx.effectiveSessionAppId !== ctx.result.id
      ) {
        clearProviderPtyState(ctx.effectiveSessionAppId)
      }
      ctx.rejectedRegistrationCandidate = ctx.result
      assertSpawnReplyWasLive(ctx.result)
    }
    ctx.rejectedRegistrationCandidate ??= ctx.result
    if (ctx.pendingRegistrationPtyId !== ctx.result.id) {
      if (ctx.pendingRegistrationPtyId) {
        ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId)
      }
      ctx.deps.runtime?.beginPtyRegistration?.(ctx.result.id, ctx.result.incarnationId)
      ctx.pendingRegistrationPtyId = ctx.result.id
    }
    // Why: admission precedes sequence/context state and every durable publication below.
    ctx.deps.runtime?.assertPtyRegistrationAllowed?.(ctx.result.id, ctx.result.incarnationId)
    if (ctx.result.providerSequence) {
      const runtimeSequenceBeforeReconcile =
        ctx.deps.runtime?.getPtyOutputSequence?.(ctx.result.id) ?? 0
      // Why kept: this is the reattach boundary in the RENDERER's sequence
      // domain, and the daemon snapshot's kitty flags mean nothing without
      // the boundary they were proven at.
      ctx.reconciledSnapshotSeq =
        ctx.deps.runtime?.synchronizePtyOutputSequenceFromProvider?.(
          ctx.result.id,
          ctx.result.providerSequence,
          sequenceBeforeProviderSpawn
        ) ?? null
      if (runtimeSequenceBeforeReconcile > sequenceBeforeProviderSpawn) {
        ctx.snapshotKittyFlagsCoverReconciledSeq = false
      }
    }
    ensureWslHookRelayForReattach(ctx.result, args.connectionId)
    ctx.deps.runtime?.preparePtyExecutionContext?.(
      ctx.result.id,
      args.connectionId
        ? null
        : ctx.result.wslDistro === undefined
          ? ctx.expectedWslDistro
          : ctx.result.wslDistro
    )
  } catch (err) {
    if (
      (ctx.isNewDaemonSession || ctx.preparedProvisionalExecutionContext) &&
      ctx.effectiveSessionAppId
    ) {
      ctx.deps.runtime?.preparePtyExecutionContext?.(ctx.effectiveSessionAppId, null, {
        resetIncarnation: true
      })
    }
    const rawMessage = err instanceof Error ? err.message : String(err)
    if (rawMessage === 'agent_session_exited_during_start' && ctx.rejectedRegistrationCandidate) {
      ctx.deps.runtime?.releaseRejectedPtyRegistrationFence?.(
        ctx.rejectedRegistrationCandidate.id,
        ctx.rejectedRegistrationCandidate.incarnationId
      )
    }
    if (ctx.pendingRegistrationPtyId) {
      ctx.deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    const spawnError = normalizeNodePtySpawnError(err)
    const isIdentityMismatch =
      isSshPtyIdentityMismatchError(spawnError) || isSshPtyIdentityMismatchError(rawMessage)
    const isExpiredSshSession =
      Boolean(args.connectionId) &&
      (spawnError.message.includes(SSH_SESSION_EXPIRED_ERROR) ||
        rawMessage.includes(SSH_SESSION_EXPIRED_ERROR))
    const exitedBeforeSpawnReply =
      ctx.rejectedRegistrationCandidate?.exitedBeforeSpawnReply === true
    restorePtySpawnGeometry(
      ctx.spawnGeometry,
      !isIdentityMismatch && (isExpiredSshSession || exitedBeforeSpawnReply)
    )
    if (args.connectionId && ctx.effectiveSessionRelayId !== undefined && isExpiredSshSession) {
      if (ctx.effectiveSessionAppId !== undefined && !isIdentityMismatch) {
        clearProviderPtyState(ctx.effectiveSessionAppId)
        deletePtyOwnership(ctx.effectiveSessionAppId)
      }
      if (!isIdentityMismatch) {
        ctx.deps.store?.markSshRemotePtyLease(
          args.connectionId,
          ctx.effectiveSessionRelayId,
          'expired'
        )
      }
    }
    if (ctx.isNewDaemonSession && ctx.sessionId !== undefined) {
      clearProviderPtyState(ctx.sessionId)
    }
    throw spawnError
  } finally {
    if (args.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.delete(args.preAllocatedHandle)
    }
  }
}
