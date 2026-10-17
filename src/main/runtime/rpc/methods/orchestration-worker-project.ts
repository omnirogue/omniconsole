import { projectLaunchManifest } from '../../../../shared/project-launch-inheritance'
import { launchManifestPrompt, sentLaunchAttachments } from '../../../../shared/launch-manifest'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  SESSION_FOLDERS_TIMEOUT_ERROR,
  type SessionFolderRelayRequest
} from '../../../../shared/session-folder-cli'
import { launchFilingReason } from '../../../../shared/session-organization-change'
import type {
  SessionProjectLaunch,
  SessionProjectReadResult,
  WorkerProjectReceipt
} from '../../../../shared/session-project-cli'
import type { ClaudeThreadMemoryOwner } from '../../../claude/claude-thread-memory'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import {
  recordedFolderRelay,
  type OrganizationRelay
} from '../../../session-organization/organization-relayed-mutation'
import { moveSessionPrepSession } from '../../../session-prep/session-prep-folders'
import {
  bindProjectLaunchContext,
  readProjectForPane
} from '../../../session-projects/project-for-pane'
import {
  projectLaunchRuntime,
  resolveProjectLaunchInMain,
  type ProjectLaunchRuntime
} from '../../../session-projects/project-launch-resolve'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { chooseProjectComputer, withComputerNotes } from './orchestration-worker-project-computer'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

/**
 * A worker inherits its coordinator's project (backend plan §2b): the project's brief, resolved
 * for the computer the worker runs on, goes ahead of its task, and its context stays on its tab.
 * `--project` names a project from outside it and files the worker there; `--no-project` opts
 * out. Organization never blocks work: when the window can't answer, the worker starts without
 * the project and the receipt says why.
 */

export type WorkerProjectRuntime = ProjectLaunchRuntime & {
  getTerminalPaneKey(handle: string): string | null
  showTerminal(
    handle: string
  ): Promise<Pick<RuntimeTerminalShow, 'tabId' | 'worktreeId' | 'executionHostId'>>
  /** Files a worker into its project as a recorded launch change. */
  filing: OrganizationRelay
}

export function workerProjectRuntime(runtime: OrcaRuntimeService): WorkerProjectRuntime {
  const relay = (request: SessionFolderRelayRequest) => runtime.requestSessionFolders(request)
  return {
    ...projectLaunchRuntime(runtime),
    getTerminalPaneKey: (handle) => runtime.getTerminalPaneKey(handle),
    showTerminal: (handle) => runtime.showTerminal(handle),
    // Why lazy: the ledger loads history, and most workers are never filed.
    filing: (request) =>
      recordedFolderRelay(sessionOrganizationLedgerFor(getProfileUserDataPath()), relay, {
        executor: { kind: 'launch', source: 'worker-start' },
        reason: launchFilingReason()
      })(request)
  }
}

/** Which project a worker joins, settled before its dispatch exists. */
export type WorkerProjectPlan =
  | { kind: 'none' }
  | { kind: 'unread'; reason: string }
  | { kind: 'project'; folder: string; fileInto: boolean }

export type WorkerProjectInheritance = {
  brief?: string
  receipt: { project?: WorkerProjectReceipt }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function windowUnreachable(error: unknown): boolean {
  const message = messageOf(error)
  return message === SESSION_FOLDERS_NO_WINDOW_ERROR || message === SESSION_FOLDERS_TIMEOUT_ERROR
}

/** The folder `--project` names and its project; a folder in no project refuses the start. */
async function readNamedProject(
  runtime: WorkerProjectRuntime,
  ref: string
): Promise<{ folderId: string; projectId: string }> {
  let read: SessionProjectReadResult
  try {
    read = (await runtime.requestSessionFolders({
      kind: 'readProject',
      folder: ref
    })) as SessionProjectReadResult
  } catch (error) {
    if (windowUnreachable(error)) {
      throw error
    }
    throw new OrchestrationError('project_not_found', `--project ${ref}: ${messageOf(error)}`)
  }
  if (!read?.project?.settings) {
    throw new OrchestrationError(
      'project_not_found',
      `“${read?.folder?.path ?? ref}” is not in a project. Set its folder up as a project in OmniConsole, or leave out --project.`
    )
  }
  return { folderId: read.folder.id, projectId: read.project.folderId }
}

export async function findWorkerProject(
  runtime: WorkerProjectRuntime,
  params: Pick<WorkerStartInput, 'from' | 'project' | 'noProject'>
): Promise<WorkerProjectPlan> {
  if (params.project && params.noProject) {
    throw new OrchestrationError('invalid_argument', 'Pass --project or --no-project, not both.')
  }
  if (params.noProject) {
    return { kind: 'none' }
  }
  const launcherProject = async () => {
    const paneKey = runtime.getTerminalPaneKey(params.from)
    return paneKey ? readProjectForPane(runtime, paneKey) : null
  }
  try {
    if (!params.project) {
      const folder = await launcherProject()
      return folder ? { kind: 'project', folder, fileInto: false } : { kind: 'none' }
    }
    const named = await readNamedProject(runtime, params.project)
    // Why: a worker whose launcher is in the project nests under it (#911); only one sent in
    // from outside is filed, or the project would not list it.
    const own = await launcherProject().catch(() => null)
    return { kind: 'project', folder: named.folderId, fileInto: own !== named.projectId }
  } catch (error) {
    if (error instanceof OrchestrationError) {
      throw error
    }
    return { kind: 'unread', reason: messageOf(error) }
  }
}

export type WorkerProject = {
  /** Who owns a local Claude worker's own memory folder; none outside a project. */
  threadMemory(dispatchId: string): ClaudeThreadMemoryOwner | undefined
  /** The paired computer the project's Computers list sends this worker to, when not `--on`. */
  on?: string
  /** Once the worker's terminal is ready: its brief, and the receipt's `project`. */
  inherit(worker: { terminalHandle: string; created: boolean }): Promise<WorkerProjectInheritance>
  /** A worker on another computer (`--on`): its brief, resolved for that computer. */
  inheritOn(server: { hostId: string; name: string }): Promise<WorkerProjectInheritance>
}

/** Settled before the dispatch exists, so a bad `--project` refuses the start with no effects. */
export async function planWorkerProject(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput
): Promise<WorkerProject> {
  const projectRuntime = workerProjectRuntime(runtime)
  const plan = await findWorkerProject(projectRuntime, params)
  const computer = await chooseProjectComputer(
    {
      ...projectRuntime,
      resolveOrchestrationWorkerServer: (selector) =>
        runtime.resolveOrchestrationWorkerServer(selector)
    },
    params,
    plan.kind === 'project' ? plan.folder : null
  )
  return {
    threadMemory: (dispatchId) =>
      plan.kind === 'project' ? { projectFolderId: plan.folder, dispatchId } : undefined,
    on: computer.on,
    inherit: async (worker) =>
      withComputerNotes(await inheritWorkerProject(projectRuntime, plan, worker), computer.notes),
    inheritOn: async (server) =>
      withComputerNotes(
        await inheritRemoteWorkerProject(projectRuntime, plan, server),
        computer.notes
      )
  }
}

type Adoption = { filed: boolean; notes: string[] }

const notInherited = (reason: string): WorkerProjectInheritance => ({
  receipt: { project: { notInherited: reason } }
})

/**
 * The brief for a worker whose terminal is ready, and its receipt. A terminal this start created
 * also keeps the context on its tab and, when sent in from outside, is filed in the project; a
 * reused one is left where it is.
 */
export async function inheritWorkerProject(
  runtime: WorkerProjectRuntime,
  plan: WorkerProjectPlan,
  worker: { terminalHandle: string; created: boolean }
): Promise<WorkerProjectInheritance> {
  if (plan.kind !== 'project') {
    return plan.kind === 'unread' ? notInherited(plan.reason) : { receipt: {} }
  }
  try {
    const terminal = await runtime.showTerminal(worker.terminalHandle)
    if (!terminal.executionHostId) {
      return notInherited('OmniConsole could not tell which computer the worker runs on.')
    }
    const target = { host: terminal.executionHostId, worktreeId: terminal.worktreeId }
    return await briefFor(runtime, plan, target, (launch) =>
      worker.created
        ? adoptWorker(runtime, plan, { ...terminal, handle: worker.terminalHandle }, launch)
        : Promise.resolve({ filed: false, notes: [] })
    )
  } catch (error) {
    return notInherited(messageOf(error))
  }
}

/**
 * A worker on another computer gets the brief resolved for that computer, in its task text
 * (backend plan §2b). Its terminal is on that computer, so nothing is kept on a tab or filed here.
 */
export async function inheritRemoteWorkerProject(
  runtime: WorkerProjectRuntime,
  plan: WorkerProjectPlan,
  server: { hostId: string; name: string }
): Promise<WorkerProjectInheritance> {
  if (plan.kind !== 'project') {
    return plan.kind === 'unread' ? notInherited(plan.reason) : { receipt: {} }
  }
  const notFiled = plan.fileInto ? [`Not filed in the project: it runs on ${server.name}.`] : []
  try {
    return await briefFor(runtime, plan, { host: server.hostId }, async () => ({
      filed: false,
      notes: notFiled
    }))
  } catch (error) {
    return notInherited(messageOf(error))
  }
}

async function briefFor(
  runtime: WorkerProjectRuntime,
  plan: Extract<WorkerProjectPlan, { kind: 'project' }>,
  target: { host: string; worktreeId?: string },
  adopt: (launch: SessionProjectLaunch) => Promise<Adoption>
): Promise<WorkerProjectInheritance> {
  const launch = await resolveProjectLaunchInMain(runtime, { folder: plan.folder, ...target })
  if (!launch) {
    return { receipt: {} }
  }
  if (launch.error) {
    return notInherited(`Project “${launch.project.name}”: ${launch.error}`)
  }
  const manifest = projectLaunchManifest(launch, {
    prompt: '',
    hostLabel: launch.host.label,
    agent: false
  })
  const adopted = await adopt({ ...launch, attachments: sentLaunchAttachments(manifest) })
  const notes = [...(launch.notes ?? []), ...adopted.notes]
  return {
    brief: launchManifestPrompt(manifest),
    receipt: {
      project: {
        folderId: launch.project.folderId,
        name: launch.project.name,
        notOnHost: launch.notOnHost.map((item) => item.title),
        ...(adopted.filed ? { filed: true } : {}),
        ...(notes.length ? { notes } : {})
      }
    }
  }
}

/** Best effort, as the launcher's own filing: each miss becomes a note, never a failed start. */
async function adoptWorker(
  runtime: WorkerProjectRuntime,
  plan: Extract<WorkerProjectPlan, { kind: 'project' }>,
  terminal: Pick<RuntimeTerminalShow, 'tabId' | 'worktreeId' | 'handle'>,
  launch: SessionProjectLaunch
): Promise<Adoption> {
  const notes: string[] = []
  const bound = await bindProjectLaunchContext(runtime, {
    tabId: terminal.tabId,
    worktreeId: terminal.worktreeId,
    items: launch.attachments
  })
  if (!bound) {
    notes.push('Its project context is not kept on its tab, so a restart will not re-deliver it.')
  }
  if (!plan.fileInto) {
    return { filed: false, notes }
  }
  try {
    await moveSessionPrepSession(
      runtime.filing,
      { tabId: terminal.tabId, paneKey: runtime.getTerminalPaneKey(terminal.handle) },
      { id: plan.folder, path: launch.project.name }
    )
    return { filed: true, notes }
  } catch (error) {
    return { filed: false, notes: [...notes, `Not filed in the project: ${messageOf(error)}`] }
  }
}
