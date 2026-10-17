import { assertSessionOutcomeIndependentSource } from './session-outcome-source-fence'
import { sessionOutcomeHookInstruction } from './session-outcome-source-authority'
import type { SessionChain } from '../../shared/session-chain-types'
import type { RpcContext } from './rpc/core'
import { sessionOutcomeStructuredAuthority } from './session-outcome-structured-authority'

export function sessionOutcomeMutationAuthority(
  context: RpcContext,
  chain: SessionChain,
  requestedSource: 'user' | 'ai'
): { source: 'user' | 'ai'; instruction?: string } {
  if (context.orchestrationCompatibilityEvidence?.agentSessionId) {
    const authority = sessionOutcomeStructuredAuthority(context, {
      paneKey: chain.sourcePaneKey,
      worktreeId: chain.sourceWorktreeId ?? chain.worktreeId
    })!
    return { source: 'ai', instruction: authority.prompt }
  }
  if (
    context.clientId === 'desktop-renderer' &&
    !context.orchestrationCapability &&
    !context.orchestrationCompatibilityEvidence
  ) {
    return { source: requestedSource }
  }
  if (
    (context.clientKind === 'mobile' || context.clientKind === 'runtime') &&
    context.pairedDeviceId &&
    !context.orchestrationCapability &&
    !context.orchestrationCompatibilityEvidence
  ) {
    return { source: requestedSource }
  }
  if (!context.orchestrationCapability && context.orchestrationCompatibilityEvidence) {
    return { source: 'ai', instruction: sessionOutcomeHookInstruction(context, chain) }
  }
  if (!context.orchestrationCapability) {
    throw new Error(
      'Outcome mutations require the authenticated user interface or the source worker dispatch capability.'
    )
  }
  const source = context.runtime.resolveTerminalPane(
    chain.sourcePaneKey,
    chain.sourceWorktreeId ?? chain.worktreeId
  )
  assertSessionOutcomeIndependentSource(context.runtime, source.handle)
  const db = context.runtime.getOrchestrationDb()
  const dispatch = db.getActiveDispatchForTerminal(source.handle)
  const paneKey = context.runtime.getTerminalPaneKey(source.handle)
  const processIncarnation = context.runtime.getTerminalProcessIncarnation(source.handle)
  if (
    !dispatch ||
    !paneKey ||
    !processIncarnation ||
    !db.verifyDispatchCapability({
      dispatchId: dispatch.id,
      capability: context.orchestrationCapability,
      paneKey,
      processIncarnation
    }).valid
  ) {
    throw new Error('The outcome caller does not own this source dispatch.')
  }
  const task = db.getTask(dispatch.task_id)
  if (!task) {
    throw new Error('The source dispatch has no persisted authorized task.')
  }
  const run = db.getRun(task.run_id)
  if (run?.origin === 'local_bound' && !run.console_job && task.hub_task_id) {
    const worker = db.getWorkerDispatch(dispatch.id)
    if (worker) {
      const options = JSON.parse(worker.start_options) as {
        executionBrief?: unknown
        resolvedWorktreeId?: unknown
      } | null
      if (options?.executionBrief != null) {
        const worktreeId = chain.sourceWorktreeId ?? chain.worktreeId
        if (
          dispatch.run_id !== run.id ||
          dispatch.hub_task_id !== task.hub_task_id ||
          run.hub_task_id !== task.hub_task_id ||
          worker.dispatch_id !== dispatch.id ||
          worker.hub_task_id !== task.hub_task_id ||
          worker.worktree_id !== worktreeId ||
          options.resolvedWorktreeId !== worktreeId ||
          typeof options.executionBrief !== 'string' ||
          !options.executionBrief.trim() ||
          options.executionBrief.length > 256_000
        ) {
          throw new Error('The persisted native source brief does not match this card dispatch.')
        }
        // The immutable card projection stores its ID; the admitted worker owns the actual prompt.
        return { source: 'ai', instruction: options.executionBrief }
      }
    }
  }
  return { source: 'ai', instruction: task.spec }
}

export function assertSessionOutcomeUser(context: RpcContext): void {
  if (
    context.orchestrationCapability ||
    context.orchestrationCompatibilityEvidence ||
    !(
      context.clientId === 'desktop-renderer' ||
      ((context.clientKind === 'mobile' || context.clientKind === 'runtime') &&
        context.pairedDeviceId)
    )
  ) {
    throw new Error(
      'This decision requires the authenticated user interface, not an agent assertion.'
    )
  }
}
