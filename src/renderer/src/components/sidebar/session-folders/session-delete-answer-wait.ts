/**
 * Before the person deletes sessions by hand: does a review decision or a Question still wait on
 * one of them? Cleanup never deletes such a session; the person may, after this warning
 * (Sal's page 1a12bf204b7a4bd1d, item 4).
 */

import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_DECISIONS_RPC,
  type AnswerWait,
  type SessionAnswerWaitsResult
} from '../../../../../shared/session-decisions'
import { withTimeout } from '../../../../../shared/promise-timeout-fallback'

export type SessionAnswerWaitFound = { session: SidebarSession; wait: AnswerWait }

/** The RPC's own limit per call (`SessionAnswerWaitsParamsSchema`). */
const ANSWER_WAITS_PER_CALL = 1_000
const ANSWER_WAITS_TIMEOUT_MS = 5_000

function readAnswerWaits(sessions: readonly SidebarSession[]): Promise<SessionAnswerWaitsResult> {
  return callRuntimeRpc<SessionAnswerWaitsResult>(
    { kind: 'local' },
    SESSION_DECISIONS_RPC.answerWaits,
    {
      sessions: sessions.map((session) => ({
        paneKey: session.paneKey,
        worktreeId: session.worktreeId,
        providerSessionId: session.providerSession?.id ?? null
      }))
    },
    { timeoutMs: ANSWER_WAITS_TIMEOUT_MS }
  )
}

/** The first session in the batch something waits on, a decision page before a Question. */
export async function findSessionAnswerWait(
  sessions: readonly SidebarSession[]
): Promise<SessionAnswerWaitFound | null> {
  // Why: a paired owner's conversation is refused by the delete itself, so it is never asked about.
  const asked = sessions.filter(
    (session) => !session.mirroredConversation && (session.paneKey || session.providerSession?.id)
  )
  if (asked.length === 0) {
    return null
  }
  const chunks: SidebarSession[][] = []
  for (let start = 0; start < asked.length; start += ANSWER_WAITS_PER_CALL) {
    chunks.push(asked.slice(start, start + ANSWER_WAITS_PER_CALL))
  }
  // Why no warning when unread: the person's own delete never waits on a host that cannot answer.
  const results = await withTimeout(
    Promise.all(chunks.map((chunk) => readAnswerWaits(chunk))),
    ANSWER_WAITS_TIMEOUT_MS,
    null
  )
  const found = chunks.flatMap((chunk, at) =>
    chunk.flatMap((session, index) =>
      (results?.[at]?.waits?.[index] ?? []).map((wait) => ({ session, wait }))
    )
  )
  return found.find((entry) => entry.wait.kind === 'review') ?? found[0] ?? null
}

export function sessionAnswerWaitConfirmation({
  session,
  wait
}: SessionAnswerWaitFound): ConfirmationDialogOptions {
  return {
    title: translate('conversations.deleteAnswerWaitTitle', 'Still waiting on you: {{name}}', {
      name: session.label
    }),
    description:
      wait.kind === 'review'
        ? translate(
            'conversations.deleteAnswerWaitReview',
            'A decision is still waiting on this session: {{title}}. Delete it anyway?',
            { title: wait.title }
          )
        : translate(
            'conversations.deleteAnswerWaitQuestion',
            'A Question on this session is still waiting for your answer. Delete it anyway?'
          ),
    confirmLabel: translate('conversations.deleteAnswerWaitConfirm', 'Delete anyway'),
    confirmVariant: 'destructive'
  }
}
