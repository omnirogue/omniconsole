import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import {
  getAgentModelProbeSpec,
  type AgentModelProbeSpec
} from '../../shared/agent-model-probe-spec'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveCodexHomeProcessLockKeyForSpawnEnv } from '../codex-cli/codex-home-process-lock'
import { isSshMuxRequestTimeoutError } from '../ssh/ssh-channel-multiplexer'
import { WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR } from '../win32-utils'
import {
  finalizeModelDiscoveryOutput,
  planModelDiscovery,
  staticModelDiscoveryResult
} from './commit-message-model-discovery-policy'
import { isModelListingSuccess, type ModelDiscoveryCache } from './model-discovery-cache'
import { planSpawnEnv, quietBackgroundAgentPlan } from './quiet-background-runs'
import { userFacingUnsafeWindowsBatchArgs } from './source-control-agent-failure'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import { runCodexProcessWithHomeLock } from './source-control-local-generation'
import { killSourceControlAgentProcess } from './source-control-local-process'
import type {
  DiscoverCommitMessageModelsResult,
  LocalProcessExecution,
  RemoteCommitMessageExecResult,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

export type CommitMessageModelDiscoveryLocalOptions = {
  cwd?: string
  wslDistro?: string
  signal?: AbortSignal
  /** A launch's explicit refresh: a failed listing on record runs again (see the cache). */
  force?: boolean
}

export async function discoverModelsLocal(input: {
  agentId: TuiAgent
  env: NodeJS.ProcessEnv | undefined
  agentCommandOverride?: string
  options: CommitMessageModelDiscoveryLocalOptions
  backslash: CommandTemplateBackslash
  spawnAgent: SpawnSourceControlAgent
  /** Reuses a listing while the CLI binary is unchanged; absent, every call spawns. */
  cache?: ModelDiscoveryCache | null
}): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getAgentModelProbeSpec(input.agentId)
  if (!spec) {
    return { success: false, error: `Agent "${input.agentId}" does not support model discovery.` }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return staticModelDiscoveryResult(spec)
  }
  const planned = planModelDiscovery(spec, input.agentCommandOverride, input.backslash)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const plan = quietBackgroundAgentPlan(input.agentId, planned.plan, 'model-discovery', {
    remote: false
  })
  const env = planSpawnEnv(plan, input.env)

  const startDiscovery = (): LocalProcessExecution<DiscoverCommitMessageModelsResult> => {
    let markProcessClosed!: () => void
    const processClosed = new Promise<void>((resolve) => {
      markProcessClosed = resolve
    })
    const result = new Promise<DiscoverCommitMessageModelsResult>((resolve) => {
      let child: SpawnedSourceControlAgentProcess
      try {
        child = input.spawnAgent({
          binary: plan.binary,
          args: plan.args,
          cwd: input.options.cwd,
          env,
          wslDistro: input.options.wslDistro,
          stdinMode: plan.stdinPayload === null ? 'ignore' : 'pipe',
          useCwdForNative: false
        })
        if (plan.stdinPayload !== null) {
          child.stdin?.on?.('error', () => {})
          child.stdin?.end(plan.stdinPayload)
        }
      } catch (error) {
        markProcessClosed()
        console.error('[commit-message] Failed to spawn model discovery:', error)
        resolve({
          success: false,
          error: `${spec.label} model discovery could not be started. Check the agent CLI configuration and try again.`
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let outputLimitExceeded = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let terminationComplete: Promise<void> | null = null
      let detachChildListeners = (): void => {}
      const startTermination = (): void => {
        terminationComplete ??= killSourceControlAgentProcess(child)
      }
      const markClosedAfterTermination = (): void => {
        void (terminationComplete ?? Promise.resolve()).then(markProcessClosed)
      }
      const finish = (value: DiscoverCommitMessageModelsResult): void => {
        if (settled) {
          return
        }
        settled = true
        input.options.signal?.removeEventListener('abort', onAbort)
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        detachChildListeners()
        if (input.agentId !== 'codex') {
          markProcessClosed()
        }
        resolve(value)
      }
      const onAbort = (): void => {
        startTermination()
        finish({ success: false, error: 'Model discovery canceled.' })
      }
      timer = setTimeout(() => {
        startTermination()
        finish({
          success: false,
          error: `${spec.label} model discovery timed out after ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s.`
        })
      }, SOURCE_CONTROL_GENERATION_TIMEOUT_MS)

      const onData = (chunk: Buffer, append: (text: string) => void): void => {
        if (
          stdout.length + stderr.length + chunk.byteLength >
          MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES
        ) {
          outputLimitExceeded = true
          startTermination()
          finish({ success: false, error: `${spec.label} returned too much model data.` })
          return
        }
        append(chunk.toString('utf-8'))
      }
      const onStdoutData = (chunk: Buffer): void => onData(chunk, (text) => (stdout += text))
      const onStderrData = (chunk: Buffer): void => onData(chunk, (text) => (stderr += text))
      const onError = (error: Error): void => {
        if (!child.pid) {
          markProcessClosed()
        }
        finish({
          success: false,
          error:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `${spec.modelDiscovery?.binary ?? spec.binary} not found on PATH. Install ${spec.label} to discover models.`
              : `${spec.label} model discovery failed to start. Check the agent CLI configuration and try again.`
        })
      }
      const onClose = (code: number | null): void => {
        markClosedAfterTermination()
        finish(
          outputLimitExceeded
            ? { success: false, error: `${spec.label} returned too much model data.` }
            : finalizeModelDiscoveryOutput(spec, stdout, stderr, code)
        )
      }
      child.stdout?.on('data', onStdoutData)
      child.stderr?.on('data', onStderrData)
      if (input.agentId === 'codex') {
        child.once('exit', markClosedAfterTermination)
        child.once('close', markClosedAfterTermination)
      }
      child.on('error', onError)
      child.on('close', onClose)
      detachChildListeners = () => {
        child.stdout?.off?.('data', onStdoutData)
        child.stderr?.off?.('data', onStderrData)
        child.off?.('error', onError)
        child.off?.('close', onClose)
      }
      input.options.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.options.signal?.aborted) {
        onAbort()
      }
    })
    return { result, processClosed }
  }
  const discover = (): Promise<DiscoverCommitMessageModelsResult> =>
    input.agentId === 'codex'
      ? runCodexProcessWithHomeLock(
          resolveCodexHomeProcessLockKeyForSpawnEnv(input.env, input.options.wslDistro),
          startDiscovery,
          input.options.signal
        )
      : startDiscovery().result
  // Why not with a signal: a caller's cancellation must never cancel another caller's listing.
  return input.cache && !input.options.signal
    ? input.cache.run(
        {
          agentId: input.agentId,
          plan,
          env,
          wslDistro: input.options.wslDistro,
          force: input.options.force
        },
        discover
      )
    : discover()
}

export async function discoverModelsRemote(input: {
  agentId: TuiAgent
  cwd: string
  execute: (
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number
  ) => Promise<RemoteCommitMessageExecResult>
  agentCommandOverride?: string
  /** With `connectionId`, a host's listing is reused across its worktrees for the lifetime. */
  cache?: ModelDiscoveryCache | null
  connectionId?: string
  refresh?: { force?: boolean }
}): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getAgentModelProbeSpec(input.agentId)
  if (!spec) {
    return { success: false, error: `Agent "${input.agentId}" does not support model discovery.` }
  }
  if (spec.modelSource === 'static' || !spec.modelDiscovery) {
    return staticModelDiscoveryResult(spec)
  }
  const planned = planModelDiscovery(spec, input.agentCommandOverride)
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const plan = quietBackgroundAgentPlan(input.agentId, planned.plan, 'model-discovery', {
    remote: true
  })
  const discover = (): Promise<DiscoverCommitMessageModelsResult> =>
    executeRemoteDiscovery(spec, plan, input.cwd, input.execute)
  return input.cache && input.connectionId
    ? input.cache.remember(
        ['remote', input.connectionId, input.agentId, plan.binary, plan.args, plan.stdinPayload],
        discover,
        isModelListingSuccess,
        input.refresh
      )
    : discover()
}

async function executeRemoteDiscovery(
  spec: AgentModelProbeSpec,
  plan: CommitMessagePlan,
  cwd: string,
  execute: (
    plan: CommitMessagePlan,
    cwd: string,
    timeoutMs: number
  ) => Promise<RemoteCommitMessageExecResult>
): Promise<DiscoverCommitMessageModelsResult> {
  let result: RemoteCommitMessageExecResult
  try {
    result = await execute(plan, cwd, SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
  } catch (error) {
    console.error('[commit-message] Remote model discovery request failed:', error)
    return {
      success: false,
      error: isSshMuxRequestTimeoutError(error)
        ? `${spec.label} model discovery took longer than ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s and may still be running on the remote host.`
        : `${spec.label} model discovery could not be reached on the remote PATH. Try again after the SSH connection recovers.`
    }
  }
  if (result.spawnError) {
    if (result.spawnError === WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR) {
      return { success: false, error: userFacingUnsafeWindowsBatchArgs(spec.label) }
    }
    if (/ENOENT/i.test(result.spawnError)) {
      return {
        success: false,
        error: `${plan.binary} not found on the remote PATH. Install ${spec.label} there.`
      }
    }
    console.error('[commit-message] Remote model discovery spawn failed:', result.spawnError)
    return {
      success: false,
      error: `${spec.label} model discovery could not be started on the remote PATH. Check the agent command there and try again.`
    }
  }
  if (result.canceled) {
    return { success: false, error: 'Model discovery canceled.' }
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `${spec.label} model discovery timed out after ${SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000}s.`
    }
  }
  return finalizeModelDiscoveryOutput(spec, result.stdout, result.stderr, result.exitCode)
}
