import type { ParsedExecutionHost } from '../../../../shared/execution-host'
import { pickProjectHost } from '../../../../shared/project-host-policy'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import type { SessionFolderRelayRequest } from '../../../../shared/session-folder-cli'
import type {
  SessionProjectReadResult,
  WorkerProjectReceipt
} from '../../../../shared/session-project-cli'
import type { OrchestrationWorkerServer } from '../../orchestration/environment-transport'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

/**
 * worker-start without `--on` follows the project's Computers list (upgrade plan PR 4): the first
 * listed computer it can use runs the worker. The coordinator's own computer keeps today's start;
 * a paired computer takes it as `--on` would. Only a new top-level worktree with a name and a repo
 * can move, since every other placement is bound to this computer.
 */

export type ProjectComputerRuntime = {
  requestSessionFolders(request: SessionFolderRelayRequest): Promise<unknown>
  showTerminal(handle: string): Promise<Pick<RuntimeTerminalShow, 'executionHostId'>>
  resolveOrchestrationWorkerServer(selector: string): OrchestrationWorkerServer
}

export type ProjectComputerChoice = {
  /** A paired computer's environment id, when the worker moves there. */
  on?: string
  notes: string[]
}

const STAYS: ProjectComputerChoice = { notes: [] }

function movable(params: WorkerStartInput): boolean {
  return (
    params.worktree === 'new-top-level' &&
    !!params.name &&
    !!params.repo &&
    params.terminal === undefined &&
    params.cwd === undefined &&
    params.accountChoiceId === undefined &&
    params.permissionMode === undefined &&
    params.executionBrief === undefined &&
    params.continueFrom === undefined &&
    params.consoleExecution === undefined &&
    !params.closeOnCompletion
  )
}

function hostName(host: ParsedExecutionHost, servers: Map<string, OrchestrationWorkerServer>) {
  if (host.kind === 'runtime') {
    return servers.get(host.id)?.name ?? host.environmentId
  }
  return host.kind === 'ssh' ? host.targetId : 'this computer'
}

async function readProjectPolicy(runtime: ProjectComputerRuntime, folder: string) {
  const read = (await runtime
    .requestSessionFolders({ kind: 'readProject', folder })
    .catch(() => null)) as SessionProjectReadResult | null
  const project = read?.project
  return project?.settings && Array.isArray(project.settings.hostPolicy)
    ? { name: project.name, policy: project.settings.hostPolicy }
    : null
}

/** `folder` is the project the worker joins, or null when it joins none. */
export async function chooseProjectComputer(
  runtime: ProjectComputerRuntime,
  params: WorkerStartInput,
  folder: string | null
): Promise<ProjectComputerChoice> {
  if (params.on || !folder) {
    return STAYS
  }
  const project = await readProjectPolicy(runtime, folder)
  if (!project) {
    return STAYS
  }
  const here = (await runtime.showTerminal(params.from).catch(() => null))?.executionHostId
  const servers = new Map<string, OrchestrationWorkerServer>()
  const pick = pickProjectHost(project.policy, (host) => {
    if (host.id === here) {
      return true
    }
    if (host.kind !== 'runtime') {
      return false
    }
    try {
      servers.set(host.id, runtime.resolveOrchestrationWorkerServer(host.environmentId))
      return true
    } catch {
      return false
    }
  })
  const passed = pick.passedOver.map((host) => hostName(host, servers))
  const passedNote = passed.length
    ? [`Passed over ${passed.join(', ')}: worker-start can't reach it from here.`]
    : []
  if (!pick.host) {
    return {
      notes: [`None of “${project.name}”'s computers can take this worker, so it runs here.`]
    }
  }
  if (pick.host.id === here) {
    return { notes: passedNote }
  }
  const server = servers.get(pick.host.id)!
  if (!movable(params)) {
    return {
      notes: [
        `“${project.name}” runs its work on ${server.name} first; this worker stays here because only --worktree new-top-level with --name and --repo can move. Pass --on ${server.name} to place it there.`
      ]
    }
  }
  return {
    on: server.environmentId,
    notes: [`Runs on ${server.name}, the first of “${project.name}”'s computers.`, ...passedNote]
  }
}

/** Adds the choice's notes to a receipt's project lines. */
export function withComputerNotes<T extends { receipt: { project?: WorkerProjectReceipt } }>(
  inherited: T,
  notes: string[]
): T {
  const project = inherited.receipt.project
  if (!notes.length || !project) {
    return inherited
  }
  const noted: WorkerProjectReceipt =
    'notInherited' in project
      ? { notInherited: [project.notInherited, ...notes].join(' ') }
      : { ...project, notes: [...(project.notes ?? []), ...notes] }
  return { ...inherited, receipt: { ...inherited.receipt, project: noted } }
}
