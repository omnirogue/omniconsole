import { isAbsolute, relative, resolve, sep } from 'node:path'
import { mkdirSync } from 'node:fs'
import { listAgentAccountChoices } from '../../../../shared/agent-account-profiles'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

/**
 * The initial working directory for a worker, resolved against its workspace.
 *
 * A folder workspace cannot create a worktree, so parallel workers are isolated by
 * folder instead. The folder must stay inside the workspace: an agent started
 * outside it would edit files nobody admitted to this Run.
 */
export function resolveWorkerStartCwd(args: {
  requestedCwd: string | undefined
  workspacePath: string | undefined
  createsWorktree: boolean
  terminal: string | undefined
}): string | undefined {
  if (!args.requestedCwd) {
    return undefined
  }
  if (args.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--cwd cannot be applied when reusing an existing terminal.'
    )
  }
  if (args.createsWorktree) {
    throw new OrchestrationError(
      'invalid_argument',
      '--cwd applies to an existing workspace; a new worktree starts at its own root.'
    )
  }
  if (!args.workspacePath) {
    throw new OrchestrationError(
      'invalid_argument',
      'This workspace has no local path, so --cwd cannot be resolved.'
    )
  }
  const root = resolve(args.workspacePath)
  const requested = isAbsolute(args.requestedCwd)
    ? resolve(args.requestedCwd)
    : resolve(root, args.requestedCwd)
  const rel = relative(root, requested)
  if (rel.startsWith('..') || rel.split(sep).includes('..') || isAbsolute(rel)) {
    throw new OrchestrationError(
      'invalid_argument',
      'The requested working folder is outside this workspace.'
    )
  }
  return requested
}

/** Create the requested folder so the spawn does not fail on a missing directory. */
export function ensureWorkerStartCwd(cwd: string | undefined): void {
  if (cwd) {
    mkdirSync(cwd, { recursive: true })
  }
}

/**
 * The session-only environment for a named account choice. An unknown choice is
 * refused rather than silently launching under whichever account happens to be
 * signed in — the Run named an actor and must get that actor.
 */
export function resolveWorkerAccountEnv(args: {
  runtime: OrcaRuntimeService
  agent: TuiAgent | undefined
  accountChoiceId: string | undefined
  terminal: string | undefined
}): Record<string, string> | undefined {
  if (!args.accountChoiceId) {
    return undefined
  }
  if (args.terminal || !args.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--account-choice-id requires worker-start to create the agent terminal.'
    )
  }
  const settings = args.runtime.getAgentAccountSettings()
  const choice = listAgentAccountChoices(settings, args.agent).find(
    (candidate) => candidate.id === args.accountChoiceId
  )
  if (!choice) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Account ${args.accountChoiceId} is not configured for ${args.agent}.`
    )
  }
  return choice.env
}

/** A reused `--terminal` must be in the worker's workspace and already run an agent. */
export async function assertReusableWorkerTerminal(
  runtime: OrcaRuntimeService,
  terminal: string,
  worktreeId: string | undefined
): Promise<void> {
  const explicitTerminal = await runtime.showTerminal(terminal)
  if (explicitTerminal.worktreeId !== worktreeId) {
    throw new OrchestrationError(
      'terminal_worktree_mismatch',
      `Terminal ${terminal} does not belong to worktree ${worktreeId}.`
    )
  }
  if (!(await runtime.isTerminalRunningAgent(terminal))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Terminal ${terminal} is not running a recognized agent.`
    )
  }
}

export type ResolvedWorkerStartPlacement = {
  requestedWorktree: string
  createsWorktree: boolean
  /** The coordinator's worktree when this start creates a child/top-level one. */
  creationWorktree: Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>> | undefined
  resolvedWorktree:
    | Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
    | undefined
  workerCwd: string | undefined
  launchEnv: Record<string, string> | undefined
}

/**
 * Where a local worker-start puts its worker: an existing workspace (optionally a
 * folder inside it), or a worktree it creates. Folder workspaces refuse worktree
 * creation, which is exactly why the folder placement exists.
 */
export async function resolveLocalWorkerPlacement(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
  coordinatorWorktreeId: string
  createsWorktree: boolean
  agent: TuiAgent | undefined
}): Promise<ResolvedWorkerStartPlacement> {
  const { runtime, params, createsWorktree } = args
  const requestedWorktree = params.worktree ?? 'current'
  // Why: a folder workspace is not a git worktree; it cannot parent a new worktree or supply its
  // repo, but a new top-level worktree from an explicit --repo needs neither.
  const fromFolder =
    createsWorktree && parseWorkspaceKey(args.coordinatorWorktreeId)?.type === 'folder'
  if (fromFolder && (requestedWorktree === 'new-child' || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A folder workspace cannot parent a new worktree or supply its repo; use --worktree new-top-level with --repo <selector>.'
    )
  }
  const creationWorktree = createsWorktree
    ? await (fromFolder
        ? runtime.showManagedTerminalWorkspace(`id:${args.coordinatorWorktreeId}`)
        : runtime.showManagedWorktree(`id:${args.coordinatorWorktreeId}`))
    : undefined
  if (creationWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? creationWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  const resolvedWorktree = creationWorktree
    ? undefined
    : await runtime.showManagedTerminalWorkspace(
        requestedWorktree === 'current' ? `id:${args.coordinatorWorktreeId}` : requestedWorktree
      )
  return {
    requestedWorktree,
    createsWorktree,
    creationWorktree,
    resolvedWorktree,
    workerCwd: resolveWorkerStartCwd({
      requestedCwd: params.cwd,
      workspacePath: resolvedWorktree?.path,
      createsWorktree,
      terminal: params.terminal
    }),
    launchEnv: resolveWorkerAccountEnv({
      runtime,
      agent: args.agent,
      accountChoiceId: params.accountChoiceId,
      terminal: params.terminal
    })
  }
}
