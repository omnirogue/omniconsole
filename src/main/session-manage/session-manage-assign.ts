/**
 * `omni session assign`: give a free, related session a new task instead of launching one. It is
 * `continue --prompt` (same queue, marker, hard stops and conversation fence) behind a "New task
 * for you:" lead, and refuses when the target is no longer free at the moment it is sent.
 */

import {
  sessionManageActorTitle,
  type SessionManageActionResult,
  type SessionManageActor
} from '../../shared/session-manage-types'
import { continueSession } from './session-manage-continue'
import {
  queuedWords,
  SessionManageRefusal,
  type SessionDeliveryDeps,
  type SessionDeliveryTarget
} from './session-manage-deliver'
import { sessionOwnerLoad } from './session-manage-owner-load'
import { assertUnattendedPolicy } from './session-manage-unattended'

export const SESSION_ASSIGN_LEAD = 'New task for you:'

export async function assignSession(
  deps: SessionDeliveryDeps,
  input: {
    actor: SessionManageActor
    target: SessionDeliveryTarget
    task: string
    /** An unfinished session chain or outcome run owns the target's turns now. */
    bound: boolean
    /** A routine owns the target: its runs land there, so it never takes another task. */
    routine?: boolean
    dryRun: boolean
  }
): Promise<{ result: SessionManageActionResult; entryId?: string }> {
  // Why: a new task is outside the original request, so only a person may hand one out.
  assertUnattendedPolicy(input.actor, 'assign')
  const { entry } = input.target
  if (input.routine) {
    throw new SessionManageRefusal(
      `“${entry.title}” belongs to a routine, so nothing was sent: launch a new session for this task instead.`
    )
  }
  const load = sessionOwnerLoad(entry, input.bound)
  if (!load.light) {
    throw new SessionManageRefusal(
      `“${entry.title}” is no longer free (${load.words}), so nothing was sent: launch a new session for this task instead.`
    )
  }
  const { result, entryId } = await continueSession(deps, {
    actor: input.actor,
    target: input.target,
    answer: { kind: 'prompt', text: input.task },
    dryRun: input.dryRun,
    lead: SESSION_ASSIGN_LEAD
  })
  const from = sessionManageActorTitle(input.actor)
  const summary = input.dryRun
    ? `Would give “${entry.title}” this task from ${from} ${queuedWords(entry, true)}.`
    : `Gave “${entry.title}” a new task from ${from}. ${queuedWords(entry, false)}`
  return { result: { ...result, action: 'assign', summary }, ...(entryId ? { entryId } : {}) }
}
