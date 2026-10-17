import type { HandlerContext } from './dispatch'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RuntimeClientError } from './runtime-client'
import type { LocalWorkflowStartAsk } from '../shared/local-workflow-run-request'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from './selectors'
import type { LocalWorkflowFindStarted } from '../shared/local-workflow-find-request'
import { LOCAL_WORKFLOW_METHODS } from '../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../shared/local-workflow-view'

const FOLLOW_INTERVAL_MS = 3_000
/** The window opens the conversation, asks for the models and admits the run: allow for all. */
const START_TIMEOUT_MS = 150_000
const SETTLED = new Set(['completed', 'failed', 'cancelled', 'recovery_required'])

/**
 * Asks the app window to open a workflow conversation in the workspace (`--worktree`, or the
 * current one) and start it; the run has the same anchor, admission and results files as one
 * started from the app.
 */
export async function startLocalWorkflowFromCli(
  ctx: HandlerContext,
  method: typeof LOCAL_WORKFLOW_METHODS.find | typeof LOCAL_WORKFLOW_METHODS.run,
  request: LocalWorkflowStartAsk
): Promise<LocalWorkflowFindStarted> {
  const worktree =
    (await getOptionalWorktreeSelector(ctx.flags, 'worktree', ctx.cwd, ctx.client)) ??
    (await resolveCurrentWorktreeSelector(ctx.cwd, ctx.client))
  const supplied = ctx.flags.get('operation-id')
  const operationId = supplied === undefined ? randomUUID() : supplied
  if (!z.string().uuid().safeParse(operationId).success || typeof operationId !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--operation-id must be a UUID; keep it for retries.'
    )
  }
  const launchRequest = { ...request, operationId, origin: request.origin ?? 'cli' }
  process.stderr.write(`Workflow operation: ${operationId} (keep --operation-id for retries).\n`)
  try {
    return (
      await ctx.client.call<LocalWorkflowFindStarted>(
        method,
        { worktree, request: launchRequest },
        { timeoutMs: START_TIMEOUT_MS }
      )
    ).result
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new RuntimeClientError(
      error instanceof RuntimeClientError ? error.code : 'workflow_start_unverified',
      `${reason} If retrying this request, keep --operation-id ${operationId} to use the same workflow.`,
      error instanceof RuntimeClientError ? error.data : undefined
    )
  }
}

/** Follows a started run through the ordinary reads until it settles; progress lines go to stderr. */
export async function followLocalWorkflow(
  ctx: HandlerContext,
  started: LocalWorkflowFindStarted,
  progress: (view: LocalWorkflowView) => string
): Promise<LocalWorkflowView> {
  const address = {
    worktree: `id:${started.worktreeId}`,
    conversationId: started.conversationId,
    executionId: started.executionId
  }
  let last = ''
  for (;;) {
    const view = (await ctx.client.call<LocalWorkflowView>(LOCAL_WORKFLOW_METHODS.show, address))
      .result
    const line = progress(view)
    if (!ctx.json && line !== last) {
      process.stderr.write(`${line}\n`)
      last = line
    }
    if (SETTLED.has(view.state)) {
      return view
    }
    await new Promise((done) => setTimeout(done, FOLLOW_INTERVAL_MS))
  }
}
