/**
 * `stop`, `restart` and `answer` on the owner service: session-manage's own controls, checked as a
 * dry run before anything moves and then carried out. A failure after a keystroke may have landed
 * (`SessionManagePartialError`) is `unconfirmed`, never "not delivered".
 */

import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import type { SessionRestartResult } from '../../shared/session-resume-types'
import type { SessionHostPrepared } from '../session-host/session-host-executor'
import type { SessionHostSettlement } from '../session-host/session-host-settlement'
import type { SessionAnswerQuarantine } from '../session-manage/session-answer-quarantine'
import {
  answerSession,
  withSessionAnswerLock,
  type SessionAnswerDeps
} from '../session-manage/session-manage-answer'
import {
  restartSession,
  stopSession,
  type SessionControlDeps,
  type SessionControlTarget
} from '../session-manage/session-manage-control'
import {
  SessionManagePartialError,
  SessionManageRefusal
} from '../session-manage/session-manage-refusal'
import type { HostSession } from './host-session-inventory'
import { refusalOf, unattendedRefusal, type OwnerTarget } from './session-host-owner-target'

export type OwnerControlDeps = {
  control: SessionControlDeps
  answer(session: HostSession): SessionAnswerDeps
  answerQuarantine: SessionAnswerQuarantine
  /** This computer's own window notice for a restart it carried out (none with no window). */
  notice?(summary: string): void
}

function controlTarget(target: OwnerTarget): SessionControlTarget {
  const { entry, row, source, agentProcess } = target.session
  return { entry, row, source, agentProcess }
}

async function settled(run: () => Promise<unknown>): Promise<SessionHostSettlement> {
  try {
    const result = (await run()) as Partial<SessionRestartResult> | null
    const summary = result?.summary
    // Why completed, with the outcome carried: a restart sends no prompt, so an `unconfirmed`
    // settlement would hold the turn reserved with nothing to protect and nothing to release it.
    if (result?.outcome === 'started_unconfirmed') {
      return {
        kind: 'completed',
        result: {
          ...(summary ? { summary } : {}),
          outcome: result.outcome,
          ...(result.reason ? { reason: result.reason } : {})
        }
      }
    }
    return { kind: 'completed', result: summary ? { summary } : {} }
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return { kind: 'not-delivered', refusal: refusalOf(error) }
    }
    if (error instanceof SessionManagePartialError) {
      return { kind: 'unconfirmed', detail: error.message }
    }
    throw error
  }
}

/** The dry run refuses before anything moves; the real run is the dispatch. */
async function checkedThen(
  dryRun: () => Promise<unknown>,
  run: () => Promise<unknown>
): Promise<SessionHostPrepared> {
  try {
    await dryRun()
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return { kind: 'refuse', refusal: refusalOf(error) }
    }
    throw error
  }
  return { kind: 'dispatch', dispatch: () => settled(run) }
}

export async function prepareHostStop(
  deps: OwnerControlDeps,
  target: OwnerTarget,
  payload: SessionHostPayloads['stop']
): Promise<SessionHostPrepared> {
  const policy = unattendedRefusal(target, 'stop')
  if (policy) {
    return { kind: 'refuse', refusal: policy }
  }
  const input = {
    actor: target.actor,
    target: controlTarget(target),
    force: payload.force === true
  }
  return await checkedThen(
    () => stopSession(deps.control, { ...input, dryRun: true }),
    () => stopSession(deps.control, { ...input, dryRun: false })
  )
}

export async function prepareHostRestart(
  deps: OwnerControlDeps,
  target: OwnerTarget
): Promise<SessionHostPrepared> {
  const policy = unattendedRefusal(target, 'restart')
  if (policy) {
    return { kind: 'refuse', refusal: policy }
  }
  const input = { actor: target.actor, target: controlTarget(target) }
  return await checkedThen(
    () => restartSession(deps.control, { ...input, dryRun: true }),
    async () => {
      const result = await restartSession(deps.control, { ...input, dryRun: false })
      if ('outcome' in result) {
        deps.notice?.(result.summary)
      }
      return result
    }
  )
}

export async function prepareHostAnswer(
  deps: OwnerControlDeps,
  target: OwnerTarget,
  payload: SessionHostPayloads['answer']
): Promise<SessionHostPrepared> {
  const policy = unattendedRefusal(target, 'answer')
  if (policy) {
    return { kind: 'refuse', refusal: policy }
  }
  const { session } = target
  const key = `${session.row.worktreeId}:${session.entry.paneKey}`
  const answer = (dryRun: boolean) =>
    withSessionAnswerLock(
      key,
      (lock) =>
        answerSession(deps.answer(session), {
          actor: target.actor,
          expect: payload.expect,
          answer: payload.answer,
          dryRun,
          lock
        }),
      deps.answerQuarantine
    )
  return await checkedThen(
    () => answer(true),
    () => answer(false)
  )
}
