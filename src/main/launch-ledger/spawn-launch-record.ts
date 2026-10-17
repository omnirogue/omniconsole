import { attemptLaunchProvenance } from './launch-provenance-guard'
import { randomUUID } from 'node:crypto'
import { takeLaunchCauseHints } from '../observability/launch-trigger-hints'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import type { PtyIpcSpawnState } from '../ipc/pty/ipc/spawn-state'
import type { RuntimePtySpawnState } from '../ipc/pty/runtime/spawn-state'
import { resolveIpcSpawnLaunchCause } from '../ipc/pty/ipc/spawn-launch-attribution'
import { recordLaunch, type LaunchLedgerInput } from './launch-ledger'

type SpawnContext = PtyIpcSpawnState | RuntimePtySpawnState
type Attempt = { input: LaunchLedgerInput; finished: boolean }
const attempts = new WeakMap<SpawnContext, Attempt>()
function requestedPaneKey(args: { tabId?: string; leafId?: string }): string | undefined {
  return args.tabId && !args.tabId.includes(':') && args.leafId && isTerminalLeafId(args.leafId)
    ? makePaneKey(args.tabId, args.leafId)
    : undefined
}
function fields(ctx: SpawnContext, runtime: boolean): LaunchLedgerInput {
  const ipc = ctx as PtyIpcSpawnState
  const host = ctx as RuntimePtySpawnState
  const fallback: LaunchLedgerInput = {
    pipeline: runtime ? 'runtime-controller' : 'renderer-ipc',
    ptyId: ctx.effectiveSessionAppId ?? null,
    tabId: ctx.args.tabId,
    worktreeId: ctx.args.worktreeId,
    agent: ctx.args.launchAgent,
    cause: { trigger: 'unknown' },
    hasStartupCommand: Boolean(ctx.launchCommand ?? ctx.args.command),
    ...(runtime ? { visible: false } : {}),
    process: 'prepared'
  }
  return attemptLaunchProvenance<LaunchLedgerInput>(
    fallback.pipeline,
    () => {
      if (!runtime) {
        ipc.launchCause ??= resolveIpcSpawnLaunchCause({
          ...ipc.args,
          hasLaunchCommand: Boolean(ipc.launchCommand ?? ipc.args.command),
          interruptedAutoContinue: ipc.interruptedAutoContinue
        })
      }
      return {
        pipeline: runtime ? 'runtime-controller' : 'renderer-ipc',
        ptyId: ctx.effectiveSessionAppId ?? null,
        paneKey:
          (runtime ? host.spawnIdentityPaneKey : ipc.validatedPaneKey) ??
          ctx.metadataPaneKey ??
          (runtime ? undefined : ipc.reservationPaneKey) ??
          requestedPaneKey(ctx.args),
        tabId: ctx.args.tabId,
        worktreeId: ctx.args.worktreeId,
        agent: ctx.args.launchAgent,
        cause: runtime
          ? host.args.launchCause
            ? { ...host.args.launchCause, actor: host.args.launchCause.actor ?? { kind: 'app' } }
            : undefined
          : ipc.launchCause,
        hasStartupCommand: Boolean(ctx.launchCommand ?? ctx.args.command),
        ...(runtime
          ? { visible: false }
          : typeof ipc.args.launchVisible === 'boolean'
            ? { visible: ipc.args.launchVisible }
            : {}),
        ...(ctx.preAdoptedStablePane ||
        ((ctx.args.sessionId || ctx.effectiveSessionAppId) &&
          !(runtime ? host.isNewDaemonSession : ipc.isMintedSessionId)) ||
        (runtime && host.args.adoptedStablePane)
          ? { intent: 'attach' as const, process: 'attachment-intent' as const }
          : { process: 'prepared' as const })
      }
    },
    fallback
  )
}
function prepare(
  ctx: SpawnContext,
  runtime: boolean,
  knownPtyId?: string,
  attached = false
): Attempt {
  const existing = attempts.get(ctx)
  if (existing) {
    return existing
  }
  const attempt = {
    input: {
      ...fields(ctx, runtime),
      ...(attached ? { process: 'attachment-intent' as const, intent: 'attach' as const } : {}),
      ...(knownPtyId ? { ptyId: knownPtyId } : {}),
      launchId: randomUUID(),
      ts: new Date().toISOString()
    },
    finished: false
  }
  attempts.set(ctx, attempt)
  recordLaunch(attempt.input)
  return attempt
}
export function prepareIpcSpawnLaunch(ctx: PtyIpcSpawnState): void {
  return attemptLaunchProvenance(
    'renderer-ipc',
    () => {
      prepare(ctx, false)
    },
    undefined
  )
}
export function prepareRuntimeSpawnLaunch(ctx: RuntimePtySpawnState): void {
  return attemptLaunchProvenance(
    'runtime-controller',
    () => {
      prepare(ctx, true)
    },
    undefined
  )
}
function complete(
  ctx: SpawnContext,
  runtime: boolean,
  result: { id?: unknown; isReattach?: boolean; incarnationId?: string },
  attached: boolean
): void {
  const isAttached =
    attached ||
    result.isReattach === true ||
    ('agentSessionEnsure' in result &&
      (result.agentSessionEnsure as { disposition?: string } | undefined)?.disposition ===
        'adopted')
  const attempt = prepare(
    ctx,
    runtime,
    typeof result.id === 'string' ? result.id : undefined,
    isAttached
  )
  if (attempt.finished) {
    return
  }
  attempt.finished = true
  recordLaunch({
    ...attempt.input,
    ptyId: typeof result.id === 'string' ? result.id : null,
    incarnationId: result.incarnationId,
    process: isAttached ? 'attached' : 'created'
  })
  if (!runtime) {
    takeLaunchCauseHints({ ...ctx.args, hasLaunchCommand: Boolean(ctx.args.command) })
  }
}
export function recordIpcSpawnLaunch(
  ctx: PtyIpcSpawnState,
  result: { id?: unknown; isReattach?: boolean; incarnationId?: string },
  attached = false
): void {
  return attemptLaunchProvenance(
    'renderer-ipc',
    () => {
      complete(ctx, false, result, attached || Boolean(ctx.preAdoptedStablePane))
    },
    undefined
  )
}
export function recordRuntimeSpawnLaunch(
  ctx: RuntimePtySpawnState,
  result: { id: string; isReattach?: boolean; incarnationId?: string },
  attached = false
): void {
  return attemptLaunchProvenance(
    'runtime-controller',
    () => {
      complete(
        ctx,
        true,
        result,
        attached || Boolean(ctx.preAdoptedStablePane || ctx.args.adoptedStablePane)
      )
    },
    undefined
  )
}
export function recordSpawnLaunchFailure(ctx: SpawnContext): void {
  return attemptLaunchProvenance(
    'spawn-failure',
    () => {
      const dispatched = attempts.get(ctx)
      const attempt = dispatched ?? prepare(ctx, 'spawnIdentityPaneKey' in ctx)
      if (attempt.finished) {
        return
      }
      const receipt = ctx.rejectedRegistrationCandidate ?? (ctx.result.id ? ctx.result : null)
      if (receipt) {
        complete(ctx, attempt.input.pipeline === 'runtime-controller', receipt, false)
        return
      }
      attempt.finished = true
      // A lost provider reply is not evidence that execution failed, especially across SSH.
      recordLaunch({ ...attempt.input, process: dispatched ? 'unknown' : 'failed' })
    },
    undefined
  )
}
