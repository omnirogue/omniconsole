import { orchestrationWorkerLaunchCause } from '../terminal-launch-cause'
import type { LaunchCause } from '../../../../shared/launch-cause'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PtyLaunchGateRequest } from '../../../../shared/pty-launch-gate'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { ClaudeThreadMemoryOwner } from '../../../claude/claude-thread-memory'

export type WorkerEffect = {
  kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'
  action?: string
  role?: string
  id?: string
  state?: string
  tabId?: string
  leafId?: string
  requested?: string
  effective?: string
  source?: string
  hookFound?: boolean
  startupPolicy?: string
  terminalId?: string
  surface?: 'visible' | 'background'
  warning?: string
}

export type WorkerSetupReceipt = {
  requested: 'run' | 'skip' | 'inherit' | 'not_applicable'
  effective: 'run' | 'skip' | 'inherit' | 'not_applicable'
  source: string
  hookFound: boolean
  startupPolicy: 'start-immediately' | 'wait-for-setup'
  state:
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'not_configured'
    | 'spawn_failed'
    | 'not_applicable'
}

export function requireWorkerAuthority(runtime: OrcaRuntimeService, terminalHandle: string) {
  const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
  const paneKey = authority?.paneKey ?? runtime.getTerminalPaneKey(terminalHandle)
  const processIncarnation =
    authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(terminalHandle)
  if (!paneKey || !processIncarnation) {
    throw new Error('stable_pane_required')
  }
  return {
    paneKey,
    processIncarnation,
    ...(authority?.launchTokenHash ? { launchTokenHash: authority.launchTokenHash } : {}),
    ...(authority?.hostScope ? { hostScope: JSON.stringify(authority.hostScope) } : {})
  }
}

export async function createExistingWorktreeWorkerTerminal(args: {
  launchCause?: LaunchCause
  launchGate?: PtyLaunchGateRequest
  runtime: OrcaRuntimeService
  worktreeId: string
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  hubTaskId?: string | null
  taskId: string
  /** Folder inside the workspace this worker starts in; already contained and created. */
  cwd?: string
  /** Session-only account environment (a config directory), never a credential. */
  launchEnv?: Record<string, string>
  threadMemory?: ClaudeThreadMemoryOwner
  effects: WorkerEffect[]
}): Promise<RuntimeTerminalCreate> {
  const terminal = await args.runtime.createTerminal(`id:${args.worktreeId}`, {
    launchCause: args.launchCause ?? orchestrationWorkerLaunchCause(args.taskId),
    // Why: the agent id is not a shell command — `cursor` resolves to the Cursor
    // desktop app while its CLI is `cursor-agent`. Let the runtime build the
    // configured launcher instead of executing the raw id.
    startupAgent: args.agent,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    // Why: `env` would count as a caller-supplied launch and be refused next to
    // startupAgent; the account directory rides inside the managed launch instead.
    ...(args.launchEnv ? { agentLaunchEnv: args.launchEnv } : {}),
    ...(args.threadMemory ? { claudeThreadMemory: args.threadMemory } : {}),
    ...(args.launchGate ? { launchGate: args.launchGate } : {}),
    ...(args.hubTaskId ? { hubTaskId: args.hubTaskId } : {}),
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
    title: `worker-${args.taskId}`,
    // Why: dispatching a worker is background work; it must not pull the sidebar
    // to the worker's workspace while the user is reading somewhere else.
    surfaceOwner: false
  })
  args.effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning
  })
  return terminal
}

export function applyWaitForSetupOutcome(
  receipt: WorkerSetupReceipt,
  effects: WorkerEffect[],
  wait: { satisfied: boolean; status: string }
): void {
  if (receipt.startupPolicy !== 'wait-for-setup' || receipt.state !== 'running') {
    return
  }
  if (wait.satisfied) {
    receipt.state = 'succeeded'
  } else if (wait.status === 'exited') {
    receipt.state = 'failed'
  } else {
    return
  }
  const setupEffect = effects.find((effect) => effect.kind === 'setup')
  if (setupEffect) {
    setupEffect.state = receipt.state
  }
}

export async function createWorkerWorktree(args: {
  launchCause: LaunchCause
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  requestedWorktree: string
  coordinatorWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  params: {
    repo?: string
    name?: string
    baseBranch?: string
    displayName?: string
    comment?: string
    setup?: 'run' | 'skip' | 'inherit'
    from: string
  }
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  /** Account directory env for the worker; the created worktree's agent launch carries it. */
  launchEnv?: Record<string, string>
  threadMemory?: ClaudeThreadMemoryOwner
  hubTaskId?: string | null
  effects: WorkerEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>
  terminalHandle: string
  setupReceipt: WorkerSetupReceipt
}> {
  const { runtime, db, dispatchId, requestedWorktree, coordinatorWorktree, params, effects } = args
  const setupDecision = params.setup ?? 'run'
  db.recordWorkerStage({ dispatchId, stage: 'worktree_creating', effects })
  const created = await runtime.createManagedWorktree({
    repoSelector: params.repo ?? coordinatorWorktree.repoId,
    name: params.name as string,
    baseBranch: params.baseBranch,
    displayName: params.displayName,
    comment: params.comment,
    // setupDecision runs setup without the legacy runHooks activation side effect.
    runHooks: false,
    setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    initiatedBy: 'agent',
    createdWithAgent: args.agent,
    startupAgent: args.agent,
    startupLaunchCause: args.launchCause,
    ...(args.hubTaskId ? { startupHubTaskId: args.hubTaskId } : {}),
    ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {}),
    // Why: a worker on a chosen account must start on that account's directory; without it
    // the new worktree's agent launched on the default home (stalled prompt, wrong trust file).
    ...(args.launchEnv ? { startupLaunchEnv: args.launchEnv } : {}),
    ...(args.threadMemory ? { startupClaudeThreadMemory: args.threadMemory } : {}),
    activate: false,
    lineage: {
      parentWorktree: requestedWorktree === 'new-child' ? coordinatorWorktree.id : undefined,
      noParent: requestedWorktree === 'new-top-level',
      callerTerminalHandle: params.from
    }
  })
  const terminalHandle = created.startupTerminal?.handle
  effects.push({
    kind: 'worktree',
    action: requestedWorktree === 'new-child' ? 'created_child' : 'created_top_level',
    id: created.worktree.id
  })
  db.recordWorkerStage({
    dispatchId,
    stage: 'worktree_created',
    worktreeId: created.worktree.id,
    effects,
    residualResources: effects
  })
  const setupReceipt = {
    requested: setupDecision,
    effective: setupDecision,
    source: params.setup ? 'explicit_request' : 'orchestration_default',
    hookFound: created.setupReceipt?.hookFound ?? false,
    startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
    state: created.setupReceipt?.state ?? 'not_configured'
  }
  if (!terminalHandle) {
    throw new Error(created.warning ?? 'Agent-first worktree creation returned no terminal.')
  }
  const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
    includeVisualLayouts: false
  })
  const setupTerminalHandle = created.setupReceipt?.terminalHandle
  for (const terminal of listed.terminals) {
    effects.push({
      kind: 'terminal',
      role:
        terminal.handle === terminalHandle
          ? 'agent'
          : terminal.handle === setupTerminalHandle
            ? 'setup'
            : 'configured_tab',
      action: terminal.handle === terminalHandle ? 'reused_agent_terminal' : 'created',
      id: terminal.handle,
      tabId: terminal.tabId,
      leafId: terminal.leafId
    })
  }
  if (
    setupTerminalHandle &&
    !listed.terminals.some((terminal) => terminal.handle === setupTerminalHandle)
  ) {
    // Why: an agent create closes its Setup tab once setup exits 0 (worktree-terminal-tidy.ts),
    // so a trivial setup can be gone before this listing. monitorWorkerSetup still needs the
    // handle; the runtime answers a closed one with the setup's own exit. Not a residual.
    effects.push({ kind: 'terminal', role: 'setup', action: 'not_listed', id: setupTerminalHandle })
  }
  const setupTerminal = effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup'
  )
  effects.push({
    kind: 'setup',
    action: setupDecision,
    requested: setupReceipt.requested,
    effective: setupReceipt.effective,
    source: setupReceipt.source,
    hookFound: setupReceipt.hookFound,
    startupPolicy: setupReceipt.startupPolicy,
    state: setupReceipt.state,
    terminalId: setupTerminalHandle ?? setupTerminal?.id
  })
  return {
    worktree: created.worktree as Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
    terminalHandle,
    setupReceipt
  }
}

export function monitorWorkerSetup(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  dispatchId: string
  setupReceipt: WorkerSetupReceipt
  effects: WorkerEffect[]
}): void {
  const setupTerminal = args.effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup' && effect.id
  )
  if (
    !setupTerminal?.id ||
    args.setupReceipt.startupPolicy !== 'start-immediately' ||
    args.setupReceipt.state !== 'running'
  ) {
    return
  }
  // Why: setup is intentionally non-gating, but command completion remains durable evidence.
  void args.runtime
    .waitForSetupTerminalCompletion(setupTerminal.id)
    .then((completion) => {
      const setupState = completion.exitCode === 0 ? 'succeeded' : 'failed'
      const evidence = args.db.updateWorkerSetupEvidence({
        dispatchId: args.dispatchId,
        setupState,
        effects: args.effects.map((effect) =>
          effect.kind === 'setup' ? { ...effect, state: setupState } : effect
        )
      })
      if (!evidence.changed) {
        return
      }
      const message = args.db.insertMessage({
        runId: args.runId,
        from: `dispatch:${args.dispatchId}`,
        to: `run:${args.runId}`,
        subject: `Setup ${setupState} for worker ${args.dispatchId}`,
        type: 'status',
        priority: setupState === 'failed' ? 'high' : 'normal',
        payload: JSON.stringify({
          dispatchId: args.dispatchId,
          setupState,
          terminalHandle: setupTerminal.id
        })
      })
      args.runtime.notifyMessageArrived(message.to_handle, message.type)
    })
    .catch(() => undefined)
}

export function isUnknownWorkerStartOutcome(error: unknown, stage: string): boolean {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (code === 'operation_unknown') {
    return true
  }
  if (stage !== 'worktree_create') {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection|disconnect|timed?\s*out|runtime changed|outcome unknown/i.test(message)
}
