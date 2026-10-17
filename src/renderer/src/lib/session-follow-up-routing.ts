import { handoffApi } from '@/components/handoffs/handoff-client'
import { FollowUpException } from '@/lib/session-follow-up-delivery'
import type { FollowUpStepState } from '@/lib/session-follow-up-step-state'
import { handoffBranchName } from '../../../shared/handoff-route-preparation'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'

/**
 * Apply the file routing rule to a captured handoff, just before it is delivered.
 *
 * Until now every file travelled the same way — uploaded as bytes — whether it was a tracked
 * source file or a PDF from the Desktop. A repository file now travels as a pushed commit on the
 * handoff branch, everything else still travels as bytes, and a file that fits neither is refused
 * with its reason instead of quietly not arriving. The manifest joins the bytes so the receiving
 * machine can put each file back where it was.
 *
 * Between agent steps on one worktree this runs but moves nothing: the next session reads the disk.
 */
function refusalMessage(refused: readonly { name: string; reason: string }[]): string {
  return refused.map((entry) => entry.reason).join(' ')
}

export async function applyHandoffRouting(
  state: FollowUpStepState,
  rule: SessionFollowUpRule
): Promise<SessionFollowUpRule> {
  const view = state.view()
  const pins = rule.files ?? []
  // A conversation delivery carries the same exact attachments and message as direct chat.
  // Replacing a folder snapshot with a repository commit would change what was selected;
  // generated history and remote paths also must stay on their captured-byte route.
  // Older saved repository handoffs and explicit session requests keep their existing route.
  if (
    !view ||
    pins.length === 0 ||
    rule.sourceConversationId ||
    rule.transcriptSource ||
    rule.agentRecipients?.length
  ) {
    return rule
  }
  const result = await handoffApi().prepareRoutes({
    workspacePath: view.chain.workspacePath,
    branch: handoffBranchName(view.chain.id),
    label: rule.taskTitle || rule.sessionLabel,
    memo: rule.note,
    pins: pins.map((pin) => ({
      sourcePath: pin.sourcePath,
      name: pin.name,
      sha256: pin.sha256,
      size: pin.size
    })),
    next: 'person',
    sameWorktree: false,
    includeWorkingTree: false
  })
  if (!result.ok) {
    throw new FollowUpException('upload-failed', '', result.error.message)
  }
  const prepared = result.data
  if (prepared.refused.length > 0) {
    // The whole send stops: a handoff that silently leaves a file behind is worse than one that
    // does not go, because the recipient cannot tell which they got.
    throw new FollowUpException(
      'file-too-large',
      prepared.refused.map((entry) => entry.name).join(', '),
      refusalMessage(prepared.refused)
    )
  }
  const note = prepared.memoLines.length
    ? [rule.note, '', ...prepared.memoLines].join('\n').slice(0, 8192)
    : rule.note
  const next: SessionFollowUpRule = {
    ...rule,
    note,
    // Pins the commit carries are gone from the byte-carried set; the manifest is now the last one.
    files: prepared.pins.map((pin) => {
      const existing = pins.find((candidate) => candidate.name === pin.name)
      return existing ? { ...existing, ...pin } : pin
    })
  }
  await state.save(next, { state: 'launching' })
  return next
}
