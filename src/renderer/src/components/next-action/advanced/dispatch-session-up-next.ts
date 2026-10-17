import { configuredNextStepOutcomes } from '../../../../../shared/next-outcome-compile'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { NextStepDraft } from '../../../../../shared/next-step-draft'
import { UP_NEXT_RPC } from '../../../../../shared/up-next-types'
import { readUpNext, writeUpNext } from '../up-next-client'
import { commitUpNext } from '../up-next-commit'
import { upNextSurface } from '../up-next-surface'
import { refused, sent, type NextStepSendResult } from '../../next-step/next-step-send-result'

/** Runs on submits a local continuation through the same host-owned composer as an agent block. */
export async function dispatchSessionUpNext(
  session: SidebarSession,
  draft: NextStepDraft
): Promise<NextStepSendResult> {
  const source = conversationSourceForSession(session)
  const actor = draft.recipients[0]
  if (
    !source ||
    (draft.placement && draft.placement !== 'local') ||
    (draft.destinationWorktreeId && draft.destinationWorktreeId !== session.worktreeId) ||
    draft.recipients.length !== 1 ||
    actor?.kind !== 'agent' ||
    draft.after.length ||
    configuredNextStepOutcomes(draft).length ||
    draft.outcomeRemovals?.length ||
    draft.note.trim() ||
    actor.accountChoiceId ||
    draft.handoff.includeTranscript ||
    draft.handoff.deliverables
  ) {
    return refused(
      'legacy_renderer_chain_creation_refused: Use the Up next composer on the execution host.'
    )
  }
  const view = await readUpNext(source)
  if (view.draftCount) {
    return refused('up_next_drafts_pending: Commit or discard the existing Up next drafts first.')
  }
  let current = view
  await writeUpNext(
    source,
    UP_NEXT_RPC.append,
    {
      draft: {
        kind: 'agent',
        template: actor.presetId ?? 'custom',
        instruction: actor.instructions,
        advanced: {
          ...(actor.model ? { model: actor.model } : {}),
          ...(actor.effort ? { effort: actor.effort } : {}),
          rounds: actor.rounds,
          endOnSuccess: draft.end === 'done'
        }
      }
    },
    (next) => {
      current = next
    }
  )
  await commitUpNext(
    current,
    upNextSurface({ kind: 'session', session }),
    () => {},
    () => {}
  )
  return sent('Queued in Up next.')
}
