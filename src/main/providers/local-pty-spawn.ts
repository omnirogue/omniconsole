import { randomUUID } from 'node:crypto'
import { win32 as pathWin32 } from 'node:path'
import * as pty from 'node-pty'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { beginLaunchStageTrace, completeLaunchStage } from '../observability/launch-stage-trace'
import { launchStageTraceArgsFor } from '../daemon/daemon-spawn-launch-stage-trace'
import { assertUnboundHubTerminalLaunch } from '../pty/hub-task-launch-admission'
import {
  consumeConsoleLaunchAuthority,
  hasConsoleLaunchAuthority,
  revalidateConsoleLaunchAuthority
} from '../pty/console-launch-authority'
import { prepareMacosTccLoginShell } from './macos-tcc-login-shell'
import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'
import { normalizeLocalCallerSessionId } from './local-pty-launch-helpers'
import { createLocalPtyLaunchPlan, DeferredLocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import {
  allocatePtyId,
  ptyShutdownOperations,
  ptyLaunchGates,
  ptyProcesses,
  ptyIncarnations
} from './local-pty-provider-state'
import { assertNativeLaunchGateRequest, PtyLaunchGate } from './pty-launch-gate'
import { trackLaunchGateShellIdentity } from './pty-launch-gate-shell-identity'
import { activateLocalPtySession } from './local-pty-session-activation'
import {
  buildLocalPtySpawnEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from './local-pty-spawn-environment'
import { awaitCancelableLocalPtySpawn, reattachLocalPty } from './local-pty-spawn-state'
import { spawnShellWithFallback } from './local-pty-utils'
import { shutdownLocalPty } from './local-pty-termination'
import { updateHistoryEnvForFallback, type HistoryInjectionResult } from '../terminal-history'
import type { PtySpawnOptions, PtySpawnResult } from './types'

export async function spawnLocalPty(
  args: PtySpawnOptions,
  getOptions: () => LocalPtyProviderOptions
): Promise<PtySpawnResult> {
  if (
    hasConsoleLaunchAuthority(args.launchGate) &&
    (args.sessionId || args.attachOnly || args.agentSessionEnsure)
  ) {
    throw new Error('pty_launch_gate_requires_fresh_local_process')
  }
  if (args.launchGate !== undefined) {
    assertNativeLaunchGateRequest(args.launchGate, args.command)
  }
  const withGate = async (
    result: PtySpawnResult,
    newlySpawned = false
  ): Promise<PtySpawnResult> => {
    if (!args.launchGate) {
      return result
    }
    const gate = ptyLaunchGates.get(result.id)
    if (!gate) {
      throw new Error('pty_launch_gate_unavailable')
    }
    try {
      const launchGate = await gate.prepare(args.launchGate, args.command)
      return { ...result, incarnationId: launchGate.incarnationId, launchGate }
    } catch (error) {
      if (newlySpawned && ptyIncarnations.get(result.id) === incarnationId) {
        await shutdownLocalPty(result.id, { immediate: true })
      }
      throw error
    }
  }
  const reattachId = normalizeLocalCallerSessionId(args.sessionId, args.attachOnly === true)
  if (reattachId) {
    const pendingShutdown = ptyShutdownOperations.get(reattachId)
    if (pendingShutdown) {
      await pendingShutdown.promise
    }
    const existing = reattachLocalPty(reattachId, args.cols, args.rows)
    if (existing) {
      return withGate(existing)
    }
  }
  if (args.attachOnly) {
    throw new SessionNotFoundError(args.sessionId ?? '')
  }
  const id = allocatePtyId(reattachId ?? undefined)
  // Why gated on a startup command: launch stages describe an agent launch; a
  // plain shell tab has no startup command, readiness barrier or hook status.
  if (args.command) {
    beginLaunchStageTrace(launchStageTraceArgsFor(id, args))
  }
  const incarnationId = randomUUID()
  const planResult = createLocalPtyLaunchPlan(args, getOptions)
  const plan =
    planResult instanceof DeferredLocalPtyLaunchPlan
      ? planResult.finish(await planResult.availability)
      : planResult
  const envResult = buildLocalPtySpawnEnvironment({
    id,
    spawn: args,
    getOptions,
    plan
  })
  const finalEnv = envResult instanceof Promise ? await envResult : envResult
  enforceLocalPtySpawnEnvironmentOverrides(args, finalEnv)
  const historyResult = finalizeLocalPtySpawnEnvironment({
    spawn: args,
    getOptions,
    plan,
    env: finalEnv
  })

  // Why: the async macOS capability probe runs before node-pty exists.
  await awaitCancelableLocalPtySpawn(id, prepareMacosTccLoginShell())
  if (args.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  // Why: another same-id request can win while this one awaits preflight; attach before launching a redundant shell.
  const concurrentWinner = reattachId ? reattachLocalPty(id, args.cols, args.rows) : null
  if (concurrentWinner) {
    return withGate(concurrentWinner)
  }
  if (hasConsoleLaunchAuthority(args.launchGate)) {
    await revalidateConsoleLaunchAuthority(
      args.launchGate,
      args.worktreeId,
      plan.effectiveCwd,
      finalEnv
    )
  }
  if (args.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  assertUnboundHubTerminalLaunch({
    env: finalEnv,
    launchGate: args.launchGate,
    worktreeId: args.worktreeId
  })
  consumeConsoleLaunchAuthority(args.launchGate)
  const spawnResult = spawnShellWithFallback({
    shellPath: plan.shellPath,
    shellArgs: plan.shellArgs,
    cols: args.cols,
    rows: args.rows,
    cwd: plan.effectiveCwd,
    env: finalEnv,
    termName: finalEnv.TERM,
    ptySpawn: pty.spawn,
    getShellReadyConfig: plan.getFallbackShellReadyConfig,
    launchEnvKeys: plan.primaryLaunchEnvKeys,
    // Why: on zsh→bash fallback HISTFILE still points to zsh_history; update before spawn so the child inherits it (design doc §8).
    onBeforeFallbackSpawn: historyResult?.historyDir
      ? (env, fallbackShell) =>
          updateHistoryEnvForFallback(env, fallbackShell, historyResult as HistoryInjectionResult)
      : undefined,
    windowsFallbackAttempts: plan.windowsFallbackAttempts
  })
  args.onPtySpawnCommitted?.()
  if (args.command) {
    completeLaunchStage(id, 'process_spawn', { outcome: 'spawned' })
  }
  plan.shellPath = spawnResult.shellPath
  // Why: a Windows fallback embeds its startup command in argv; honor the winning shell's delivery flag to avoid a double write.
  if (spawnResult.startupCommandDeliveredInShellArgs !== undefined) {
    plan.startupCommandDeliveredInShellArgs = spawnResult.startupCommandDeliveredInShellArgs
  }
  if (args.command && plan.getFallbackShellReadyConfig) {
    plan.shellReadyLaunch = plan.getFallbackShellReadyConfig(plan.shellPath)
  }

  if (process.platform !== 'win32') {
    finalEnv.SHELL = plan.shellPath
  }

  const proc = spawnResult.process
  if (args.launchGate) {
    if (args.launchGate.processObservation) {
      trackLaunchGateShellIdentity(proc)
    }
    const gate = new PtyLaunchGate({
      request: args.launchGate,
      command: args.command!,
      ptyId: id,
      incarnationId,
      pid: proc.pid,
      reportsChildExitStatus: spawnResult.reportsChildExitStatus === true,
      shellOwner: proc,
      shellPath: plan.shellPath,
      isLive: () =>
        ptyProcesses.get(id) === proc &&
        ptyIncarnations.get(id) === incarnationId &&
        !ptyShutdownOperations.has(id),
      write: proc.write.bind(proc)
    })
    // All native writes, including readiness fallbacks and query replies, cross this gate.
    proc.write = gate.write
    ptyLaunchGates.set(id, gate)
  }
  const spawnedShellIsWsl =
    process.platform === 'win32' && pathWin32.basename(plan.shellPath).toLowerCase() === 'wsl.exe'
  const spawnedWslDistro = spawnedShellIsWsl
    ? (plan.launchWslDistro ?? undefined)
    : process.platform === 'win32'
      ? null
      : undefined
  return withGate(
    activateLocalPtySession({
      id,
      incarnationId,
      spawn: args,
      getOptions,
      plan,
      env: finalEnv,
      proc,
      reportsChildExitStatus: spawnResult.reportsChildExitStatus !== false,
      spawnedWslDistro
    }),
    true
  )
}
