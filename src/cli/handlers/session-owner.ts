/**
 * `omni session find-owner|assign` — before launching a new session, find a free session already
 * doing related work and give it the task instead. One `sessionManage.*` call each.
 */

import {
  SESSION_MANAGE_RPC,
  type SessionManageActionResult
} from '../../shared/session-manage-types'
import {
  SESSION_OWNER_MAX_FILES,
  SESSION_OWNER_TASK_MAX_CHARS,
  type SessionFindOwnerResult
} from '../../shared/session-owner-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { formatSessionAction } from '../session-manage-format'
import { formatSessionFindOwner } from '../session-owner-format'
import { explicitTarget, refuseRemote } from './session-manage-access'
import { sessionProvenance } from './session-provenance-flags'
import { continueWhenIdle, whenIdleOptions } from './session-reuse'

const FIND_OWNER_TIMEOUT_MS = 180_000
/** Unarchive, resume (its agent confirms within 30 s), wait until free (45 s), then assign. */
const ASSIGN_REF_TIMEOUT_MS = 180_000

function taskFlag(flags: HandlerContext['flags']): string {
  const task = getRequiredStringFlag(flags, 'task').trim()
  if (!task || task.length > SESSION_OWNER_TASK_MAX_CHARS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--task must contain 1–${SESSION_OWNER_TASK_MAX_CHARS} characters.`
    )
  }
  return task
}

export const SESSION_OWNER_HANDLERS: Record<string, CommandHandler> = {
  'session find-owner': async ({ client, flags, json }) => {
    refuseRemote(client)
    const task = taskFlag(flags)
    const folder = getOptionalStringFlag(flags, 'folder')?.trim()
    const repo = getOptionalStringFlag(flags, 'repo')?.trim()
    const worktree = getOptionalStringFlag(flags, 'worktree')?.trim()
    const files = getOptionalStringFlag(flags, 'files')
      ?.split(',')
      .map((file) => file.trim())
      .filter(Boolean)
    if (files && files.length > SESSION_OWNER_MAX_FILES) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--files takes at most ${SESSION_OWNER_MAX_FILES} paths.`
      )
    }
    const response = await client.call<SessionFindOwnerResult>(
      SESSION_MANAGE_RPC.findOwner,
      {
        task,
        ...(files?.length ? { files } : {}),
        ...(worktree ? { worktree } : {}),
        ...(folder ? { folder } : {}),
        ...(repo ? { repo } : {})
      },
      { timeoutMs: FIND_OWNER_TIMEOUT_MS }
    )
    printResult(response, json, formatSessionFindOwner)
  },
  'session assign': async (context) => {
    const { client, flags, json } = context
    refuseRemote(client)
    const task = taskFlag(flags)
    const provenance = sessionProvenance(flags)
    if (!provenance.reason) {
      throw new RuntimeClientError(
        'invalid_argument',
        'session assign needs --reason "<why this session>" (from find-owner) so the action log explains the choice. Nothing was sent.'
      )
    }
    const whenIdle = whenIdleOptions(flags)
    const ref = getOptionalStringFlag(flags, 'ref')?.trim()
    if (ref && !whenIdle) {
      if (getOptionalStringFlag(flags, 'pane') ?? getOptionalStringFlag(flags, 'terminal')) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Pass --ref alone, not with --terminal or --pane.'
        )
      }
      // Why main resolves it: an archived or closed conversation is unarchived or resumed first.
      const response = await client.call<SessionManageActionResult>(
        SESSION_MANAGE_RPC.assign,
        { ref, task, ...provenance },
        { timeoutMs: ASSIGN_REF_TIMEOUT_MS }
      )
      printResult(response, json, formatSessionAction)
      return
    }
    const target = await explicitTarget(client, flags)
    if (whenIdle) {
      await continueWhenIdle(context, target, task, whenIdle, 'assign')
      return
    }
    const response = await client.call<SessionManageActionResult>(SESSION_MANAGE_RPC.assign, {
      target,
      task,
      ...provenance
    })
    printResult(response, json, formatSessionAction)
  }
}
