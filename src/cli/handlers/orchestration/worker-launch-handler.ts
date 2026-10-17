import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_PROJECT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_COMPLETION_POLICY_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { WorkerProjectReceipt } from '../../../shared/session-project-cli'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

/** The project lines of the human output; a project that could not be read shows only when named. */
function workerProjectLines(project: WorkerProjectReceipt | undefined, named: boolean): string[] {
  if (!project) {
    return []
  }
  if ('notInherited' in project) {
    return named ? [`Project not inherited: ${project.notInherited}`] : []
  }
  return [
    `Project: ${project.name}${project.filed ? ' (filed there)' : ''}`,
    ...project.notOnHost.map((title) => `Not on its computer: ${title} (left out)`),
    ...(project.notes ?? [])
  ]
}

export const ORCHESTRATION_WORKER_LAUNCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration worker-start': async ({ flags, client, cwd, json }) => {
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    const project = getOptionalStringFlag(flags, 'project')
    const noProject = flags.get('no-project') === true
    const closeOnCompletion = flags.get('close-on-completion') === true
    const keepAsConversation = flags.get('keep-as-conversation') === true
    if (closeOnCompletion && keepAsConversation) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--close-on-completion and --keep-as-conversation cannot be combined.'
      )
    }
    let capabilities: string[] | undefined
    const requireCapability = async (capability: string, what: string) => {
      capabilities ??= (await client.call<RuntimeStatus>('status.get')).result.capabilities ?? []
      if (!capabilities.includes(capability)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          `The connected OmniConsole runtime does not support ${what}. Update or restart OmniConsole and try again.`
        )
      }
    }
    if (model || effort) {
      await requireCapability(
        ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
        'worker model or effort overrides'
      )
    }
    // Why: an older runtime strips unknown params, so the worker would start in the wrong project.
    if (project || noProject) {
      await requireCapability(
        ORCHESTRATION_WORKER_PROJECT_RUNTIME_CAPABILITY,
        '--project or --no-project'
      )
    }
    if (closeOnCompletion) {
      await requireCapability(
        ORCHESTRATION_WORKER_COMPLETION_POLICY_RUNTIME_CAPABILITY,
        '--close-on-completion'
      )
    }
    const result = await callOrchestrationMutation<{
      runId: string
      taskId: string
      dispatchId: string
      state: string
      failedStage?: string
      lastError?: string
      warning?: string
      effects: unknown[]
      residualResources: unknown[]
      project?: WorkerProjectReceipt
    }>(client, flags, 'orchestration.workerStart', {
      task: getRequiredStringFlag(flags, 'task'),
      on: getOptionalStringFlag(flags, 'on'),
      worktree: getOptionalStringFlag(flags, 'worktree'),
      name: getOptionalStringFlag(flags, 'name'),
      repo: getOptionalStringFlag(flags, 'repo'),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      displayName: getOptionalStringFlag(flags, 'display-name'),
      comment: getOptionalStringFlag(flags, 'comment'),
      setup: getOptionalStringFlag(flags, 'setup'),
      agent: getOptionalStringFlag(flags, 'agent'),
      model,
      effort,
      terminal: getOptionalStringFlag(flags, 'terminal'),
      retryOf: getOptionalStringFlag(flags, 'retry-of'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
      devMode: isDevCliInvocation(),
      ...(project ? { project } : {}),
      ...(noProject ? { noProject } : {}),
      ...(closeOnCompletion
        ? { closeOnCompletion: true }
        : keepAsConversation
          ? { closeOnCompletion: false }
          : {})
    })
    if (result.result.state !== 'ready') {
      process.exitCode = 1
    }
    printResult(result, json, (worker) => {
      const base = [
        `Worker ${worker.dispatchId} [${worker.state}] for ${worker.taskId}`,
        ...workerProjectLines(worker.project, !!project)
      ].join('\n')
      if (worker.lastError) {
        return `${base}\n${worker.failedStage ?? 'start'}: ${worker.lastError}`
      }
      return worker.warning ? `${base}\nWarning: ${worker.warning}` : base
    })
  }
}
