import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  readConsoleTaskCard,
  readConsoleTaskSessions,
  readConsoleSourceSessionBinding
} from '../backoffice/console-session-task'
import { admitHubLinkedLaunch } from './orchestration/hub-linked-launch-admission'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'

export type AttachedPlanningSourceIo = {
  taskCard: typeof readConsoleTaskCard
  taskSessions: typeof readConsoleTaskSessions
  sourceBinding: typeof readConsoleSourceSessionBinding
  principal?: () => Promise<string | null>
}
const liveIo: AttachedPlanningSourceIo = {
  taskCard: readConsoleTaskCard,
  taskSessions: readConsoleTaskSessions,
  sourceBinding: readConsoleSourceSessionBinding,
  principal: readSessionOutcomePrincipal
}

/** Turns a server-confirmed session attachment into a pristine local planning coordinator. */
export async function ensureAttachedSessionOutcomePlanningSource(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  expected: { taskId: string; sessionId: string },
  principal: string | null,
  io: AttachedPlanningSourceIo = liveIo
): Promise<void> {
  if (!principal) {
    throw new Error('Sign in before committing a card-linked native continuation.')
  }
  const source = runtime.resolveSessionOutcomePlanningCoordinator(
    chain.sourcePaneKey,
    chain.sourceWorktreeId ?? chain.worktreeId
  )
  const canonical = LEDGER_ID_PATTERN.test(expected.sessionId)
  const [cardResult, sessionsResult, bindingResult] = await Promise.all([
    io.taskCard({ taskId: expected.taskId }),
    canonical
      ? Promise.resolve({ ok: true as const, data: { sessions: [] } })
      : io.taskSessions({ taskId: expected.taskId }),
    io.sourceBinding(expected.sessionId, principal)
  ])
  if (!cardResult.ok || !sessionsResult.ok || !bindingResult.ok) {
    throw new Error('The attached task could not be authenticated before Save.')
  }
  if (
    cardResult.data.id !== expected.taskId ||
    (!canonical &&
      sessionsResult.data.sessions.filter((session) => session.id === expected.sessionId).length !==
        1)
  ) {
    throw new Error('The source conversation is not attached to this task on the server.')
  }
  const refs = [
    source.paneKey,
    ...(source.handle.startsWith('agent-session:')
      ? [source.handle.slice('agent-session:'.length)]
      : [])
  ]
  if (
    bindingResult.data.id !== expected.sessionId ||
    bindingResult.data.board_task_id !== expected.taskId ||
    !refs.includes(bindingResult.data.session_ref)
  ) {
    throw new Error('The attached task session does not identify the actual source conversation.')
  }
  if (io.principal && (await io.principal()) !== principal) {
    throw new Error('The signed company/person changed while authenticating the attached task.')
  }
  const current = runtime.resolveSessionOutcomePlanningCoordinator(
    chain.sourcePaneKey,
    chain.sourceWorktreeId ?? chain.worktreeId
  )
  if (JSON.stringify(current) !== JSON.stringify(source)) {
    throw new Error('The source conversation changed while authenticating its task attachment.')
  }
  admitHubLinkedLaunch(runtime.getOrchestrationDb(), {
    linkedItem: { title: cardResult.data.title, hubTaskId: expected.taskId },
    launchHubTaskId: expected.taskId,
    coordinatorHandle: source.handle,
    coordinatorPaneKey: source.paneKey,
    coordinatorProcessIncarnation: source.processIncarnation
  })
}
