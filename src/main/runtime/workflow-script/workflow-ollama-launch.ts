import { resolveOllamaBaseUrl } from '../../local-ollama/ollama-inventory'
import type { WorkflowLaunchCommand, WorkflowLaunchMode } from './local-workflow-provider-commands'
import { workflowCallTimeoutMs, WORKFLOW_OLLAMA_FROZEN_TIMEOUT_MS } from './workflow-call-timeout'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import {
  OLLAMA_NOT_RUNNING,
  workflowOllamaCallContext,
  workflowOllamaInstalled,
  workflowOllamaProfile
} from './workflow-ollama-catalog'
import { OLLAMA_WORKER_SCRIPT } from './workflow-ollama-worker'

const OLLAMA_WORKSPACE_READ_TIMEOUT_MS = 30 * 60_000

/** One call on a local Ollama model: the worker process, sized to this prompt. */
export async function workflowOllamaCommand(launch: {
  model: string
  input: Parameters<WorkflowAttemptLaunch>[0]
  prompt: string
  mode: WorkflowLaunchMode
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<WorkflowLaunchCommand> {
  const { model, input, prompt, mode } = launch
  const base = resolveOllamaBaseUrl()
  const workspaceRead = mode.access === 'workspace-read'
  return {
    program: process.execPath,
    args: ['-e', OLLAMA_WORKER_SCRIPT],
    cwd: launch.cwd,
    env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1', OMNI_WORKFLOW_OLLAMA_URL: base },
    input: JSON.stringify({
      model,
      attemptId: input.attemptId,
      prompt,
      ...(mode.output === 'schema' ? { schema: input.call.schema } : {}),
      mode: mode.access,
      root: mode.root,
      ...workflowOllamaCallContext({
        model,
        promptChars: prompt.length,
        workspaceRead,
        limit: (await workflowOllamaProfile(model, base))?.contextTokens
      }),
      timeoutMs:
        workflowCallTimeoutMs(input.call.timeoutMs) ??
        (workspaceRead ? OLLAMA_WORKSPACE_READ_TIMEOUT_MS : WORKFLOW_OLLAMA_FROZEN_TIMEOUT_MS)
    })
  }
}

/**
 * Before a run starts: the model is still installed, can use tools when it must read files, and
 * reads enough for the kind of call it will get, so a model too small is named now, not mid-run.
 */
export async function preflightWorkflowOllamaSeat(
  model: string,
  workspaceRead: boolean
): Promise<void> {
  if (!(await workflowOllamaInstalled(model))) {
    throw new Error(
      `Ollama: ${model} is not installed or Ollama is not running. ${OLLAMA_NOT_RUNNING}`
    )
  }
  const profile = await workflowOllamaProfile(model)
  if (workspaceRead && !profile?.tools) {
    throw new Error(
      `Ollama model ${model} does not support tools. Choose Knowledge only or a model with tools.`
    )
  }
  workflowOllamaCallContext({ model, promptChars: 0, workspaceRead, limit: profile?.contextTokens })
}
