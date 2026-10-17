import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { abbreviateOrchestrationTasks } from '../../../shared/orchestration-task-summary'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import {
  dependentVerifyTaskSpec,
  resolveTemplatedTaskSpec,
  reviewTriggerNote
} from './task-template-handlers'

const TASK_STATUS_VALUES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

/**
 * The implement task's verify task, keyed `<implement request>:verify`. A lost answer is reported
 * under the IMPLEMENT request, so its one retry replays that create and then this one, never a
 * second verify task and never the implement payload under this key.
 */
async function createVerifyTask(
  client: Parameters<CommandHandler>[0]['client'],
  implementRequestId: string,
  params: Record<string, unknown>
): Promise<{ result: { task: { id: string; status: string } } }> {
  const verifyRequestId = `${implementRequestId}:verify`
  try {
    return await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskCreate',
      params,
      { orchestrationRequestId: verifyRequestId }
    )
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || !error.data || typeof error.data !== 'object') {
      throw error
    }
    throw orchestrationMutationRecoveryError(
      new RuntimeClientError(
        error.code,
        error.message.split(verifyRequestId).join(implementRequestId),
        { ...error.data, orchestrationRequestId: implementRequestId }
      )
    )
  }
}

export const ORCHESTRATION_TASK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration task-create': async ({ flags, client, cwd, json }) => {
    const templated = await resolveTemplatedTaskSpec(flags, cwd)
    if (templated && flags.has('print-spec')) {
      // Why: a dry run must not need a runtime, a Run or a coordinator terminal.
      console.log(json ? JSON.stringify(templated, null, 2) : templated.spec)
      return
    }
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const pairsVerify = templated?.template === 'implement' && !flags.has('no-verify')
    // Why a known id: the verify create derives its own from it, so one retry recovers both.
    const requestId = pairsVerify
      ? (getOptionalStringFlag(flags, 'retry-request') ?? randomUUID())
      : undefined
    const result = await callOrchestrationMutation<{ task: { id: string; status: string } }>(
      client,
      requestId ? new Map([...flags, ['retry-request', requestId]]) : flags,
      'orchestration.taskCreate',
      {
        spec: templated?.spec ?? getRequiredStringFlag(flags, 'spec'),
        taskTitle: getOptionalStringFlag(flags, 'task-title') ?? templated?.title,
        displayName: getOptionalStringFlag(flags, 'display-name'),
        deps: getOptionalStringFlag(flags, 'deps'),
        parent: getOptionalStringFlag(flags, 'parent'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle
      }
    )
    const verify = pairsVerify ? dependentVerifyTaskSpec(templated, result.result.task.id) : null
    const verified =
      verify && requestId
        ? await createVerifyTask(client, requestId, {
            spec: verify.spec,
            taskTitle: verify.title,
            deps: JSON.stringify([result.result.task.id]),
            parent: getOptionalStringFlag(flags, 'parent'),
            run: getOptionalStringFlag(flags, 'run'),
            callerTerminalHandle
          })
        : null
    const output = verified
      ? { ...result, result: { ...result.result, verifyTask: verified.result.task } }
      : result
    printResult(
      output,
      json,
      (r) =>
        `Created ${r.task.id} [${r.task.status}]${reviewTriggerNote(templated)}${
          verified
            ? `\nCreated verify task ${verified.result.task.id} [${verified.result.task.status}], which waits on ${r.task.id}. Dispatch it to a different worker; --no-verify skips it.`
            : ''
        }`
    )
  },

  'orchestration task-list': async ({ flags, client, cwd, json }) => {
    const brief = flags.has('brief')
    const run = getOptionalStringFlag(flags, 'run')
    const callerTerminalHandle = run
      ? undefined
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      tasks: {
        id: string
        spec: string
        task_title?: string | null
        display_name?: string | null
        status: string
        assignee_handle?: string | null
        dispatch_id?: string | null
        spec_truncated?: boolean
      }[]
      count: number
      runId?: string
      legacyReadOnly?: boolean
    }>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined,
      brief: brief ? true : undefined,
      run,
      callerTerminalHandle
    })
    // Why: only older runtimes (no spec_truncated) skip server-side abbreviation and need this client-side fallback.
    const needsClientAbbreviation =
      brief && result.result.tasks.some((task) => task.spec_truncated === undefined)
    const output = needsClientAbbreviation
      ? {
          ...result,
          result: { ...result.result, tasks: abbreviateOrchestrationTasks(result.result.tasks) }
        }
      : result
    printResult(output, json, (r) => {
      if (r.count === 0) {
        return r.legacyReadOnly ? 'No legacy tasks (read-only).' : 'No tasks.'
      }
      const tasks = r.tasks
        .map((task) => {
          const label = task.display_name ?? task.task_title ?? task.spec
          const head = `${task.id} [${task.status}] ${label.slice(0, 60)}`
          if (task.status === 'dispatched' && task.assignee_handle) {
            return `${head} -> ${task.assignee_handle} (${task.dispatch_id ?? '?'})`
          }
          return head
        })
        .join('\n')
      return r.legacyReadOnly ? `Legacy Run ${r.runId} (read-only)\n${tasks}` : tasks
    })
  },

  'orchestration task-update': async ({ flags, client, cwd, json }) => {
    const status = getRequiredStringFlag(flags, 'status')
    if (!TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid status '${status}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
      )
    }
    const result = await callOrchestrationMutation<{ task: { id: string; status: string } }>(
      client,
      flags,
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status,
        result: getOptionalStringFlag(flags, 'result'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printResult(result, json, (r) => `Updated ${r.task.id} -> ${r.task.status}`)
  }
}
