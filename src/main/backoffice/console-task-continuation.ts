import { assertLocalOmpRoute } from '../omp/omp-route-preflight'
import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import type {
  ConsoleTaskContinuationRequest,
  ConsoleLocalExecutionView
} from '../../shared/console-local-execution'
import { consoleTaskContinuationRequest } from '../../shared/console-task-continuation'
import type { ConsoleTaskContinuationResult } from '../../shared/console-task-continuation'
import { checkAgentLaunchPreferences } from '../../shared/agent-launch-preference-check'
import { jobId, workflowId } from '../../shared/console-workflow-schemas'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { gitExecFileAsync } from '../git/runner'
import { getConsoleLocalExecution } from '../console-workflows/console-local-execution-registration'
import { readConsoleWorkflowHandoff } from './console-workflow-handoff'
import {
  captureConsoleWorkflowPerson,
  sanitizeConsoleWorkflowText
} from './console-workflow-person'
import { failure, requestConsoleWorkflow, validated } from './console-workflow-transport'
import { getNativeLocalPtyProvider } from '../ipc/pty/provider/registry'
import { consoleJobRepositoryIdentity } from '../console-workflows/console-job-repository-identity'
import { readConsoleTaskContinuationCapability } from './console-task-continuation-capability'

const admission = z.object({
  ok: z.literal(true),
  workflow_id: workflowId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  job_id: jobId
})

type Workspace =
  | { kind: 'folder'; path: string; host: 'local' }
  | {
      kind: 'git'
      path: string
      host: 'local'
      repo: string
      base_branch: string
      base_sha: string
    }

export async function resolveWorkspace(
  runtime: OrcaRuntimeService,
  selector: string
): Promise<Workspace> {
  const workspace = await runtime.showManagedTerminalWorkspace(selector)
  if (workspace.hostId && workspace.hostId !== 'local') {
    throw new Error(
      'Continue this task on its execution host. This desktop can start local work only.'
    )
  }
  const path = await realpath(workspace.path)
  if (!(await stat(path)).isDirectory()) {
    throw new Error('The selected work location is not a directory.')
  }
  if (parseWorkspaceKey(workspace.id)?.type === 'folder') {
    return { kind: 'folder', path, host: 'local' }
  }
  const repo = await runtime.showRepo(workspace.repoId)
  if (repo.connectionId || (repo.executionHostId && repo.executionHostId !== 'local')) {
    throw new Error('The selected repository belongs to another execution host.')
  }
  if (repo.kind === 'folder') {
    throw new Error('Open this folder as a folder workspace before continuing the task.')
  }
  const remote = (
    await gitExecFileAsync(['remote', 'get-url', 'origin'], { cwd: path })
  ).stdout.trim()
  if (!normalizeGitRemoteUrl(remote)) {
    throw new Error('The selected repository does not have a verifiable origin.')
  }
  const baseBranch = (
    await gitExecFileAsync(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: path })
  ).stdout.trim()
  const baseSha = (
    await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], { cwd: path })
  ).stdout.trim()
  if (!baseBranch || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error('Choose a Git worktree with a named branch and a verifiable commit.')
  }
  return {
    kind: 'git',
    path,
    host: 'local',
    repo: remote,
    base_branch: baseBranch,
    base_sha: baseSha
  }
}

/** The server admits the requested task; the existing local job service owns claim and execution. */
export async function continueConsoleTask(
  runtime: OrcaRuntimeService,
  args: ConsoleTaskContinuationRequest
): Promise<ConsoleTaskContinuationResult> {
  let admissionRequested = false
  const result = await validated<ConsoleTaskContinuationRequest, ConsoleLocalExecutionView>(
    args,
    consoleTaskContinuationRequest,
    async (input) => {
      const preferences = checkAgentLaunchPreferences(input.agent, {
        model: input.model,
        openrouterCandidates: input.openrouterCandidates,
        effort: input.effort
      })
      if (!preferences.ok) {
        return failure('invalid_request', 'This agent cannot apply the selected model and effort.')
      }
      try {
        if (getNativeLocalPtyProvider().supportsLaunchGateObservation?.() !== true) {
          return failure(
            'capability_unavailable',
            'This execution host cannot verify the held process birth and exit.'
          )
        }
        const person = await captureConsoleWorkflowPerson()
        if (!person.ok) {
          return person
        }
        const workspace = await resolveWorkspace(runtime, input.worktree)
        if (!person.data.isCurrent()) {
          return failure(
            'connection_changed',
            'The signed-in person changed before task admission.'
          )
        }
        const capability = await readConsoleTaskContinuationCapability(
          { taskId: input.taskId },
          person.data.principal
        )
        if (!capability.ok) {
          return capability
        }
        if (!capability.data.available) {
          return failure(
            'capability_unavailable',
            capability.data.reason || 'Task continuation is unavailable on this server.'
          )
        }
        if (!person.data.isCurrent()) {
          return failure(
            'connection_changed',
            'The signed-in person changed before task admission.'
          )
        }
        if (input.agent === 'omp') {
          if (capability.data.openrouter_routing !== true) {
            return failure(
              'capability_unavailable',
              'The server cannot preserve an exact OMP route.'
            )
          }
          await assertLocalOmpRoute(runtime, input.worktree, input)
        }
        admissionRequested = true
        const admitted = await requestConsoleWorkflow(
          `/api/gtd/workflow-tasks/${input.taskId}/continue`,
          'POST',
          admission,
          {
            operation_id: input.operationId,
            ...(input.goalId ? { goal_id: input.goalId } : {}),
            ...(input.threadId ? { thread_id: input.threadId } : {}),
            provider: input.agent,
            model: input.model,
            ...(input.openrouterCandidates !== undefined
              ? { openrouter_candidates: input.openrouterCandidates }
              : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            instruction: input.instruction,
            workspace
          },
          30_000,
          true,
          person.data.principal
        )
        if (!admitted.ok) {
          return admitted
        }
        const ready = await readConsoleWorkflowHandoff(admitted.data.job_id, person.data.principal)
        if (!ready.ok) {
          return ready
        }
        const job = ready.data
        if (
          job.taskId !== input.taskId ||
          job.workflowId !== admitted.data.workflow_id ||
          job.digest !== admitted.data.digest ||
          job.provider !== input.agent ||
          job.model !== input.model ||
          JSON.stringify(job.openrouterCandidates) !== JSON.stringify(input.openrouterCandidates) ||
          (job.effort ?? null) !== (input.effort ?? null) ||
          job.prompt !== input.instruction ||
          job.placement !== 'local' ||
          (workspace.kind === 'folder'
            ? job.workspace?.kind !== 'folder' || job.workspace.path !== workspace.path
            : Boolean(job.workspace) ||
              consoleJobRepositoryIdentity(job.repo ?? '') !==
                normalizeGitRemoteUrl(workspace.repo)?.toLowerCase() ||
              job.baseBranch !== workspace.base_branch ||
              job.baseSha !== workspace.base_sha)
        ) {
          return failure(
            'invalid_response',
            'The admitted job changed the selected task, agent, instruction or work location. No agent was started.'
          )
        }
        const currentWorkspace = await resolveWorkspace(runtime, input.worktree)
        if (
          !person.data.isCurrent() ||
          JSON.stringify(currentWorkspace) !== JSON.stringify(workspace)
        ) {
          return failure(
            'connection_changed',
            'The person or work location changed before activation. No agent was started.'
          )
        }
        return getConsoleLocalExecution(runtime).start({
          jobId: job.id,
          workflowId: job.workflowId,
          approvedDigest: job.digest,
          worktree: input.worktree
        })
      } catch (error) {
        return failure(
          'task_continuation_refused',
          sanitizeConsoleWorkflowText(
            error instanceof Error ? error.message : 'The task execution could not be verified.'
          ).slice(0, 1500)
        )
      }
    }
  )
  return result.ok
    ? result
    : { ...result, launchDisposition: admissionRequested ? 'unverifiable' : 'not-started' }
}
