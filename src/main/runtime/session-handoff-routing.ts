import { handoffBranchName } from '../../shared/handoff-route-preparation'
import { FollowUpException } from '../../shared/session-follow-up-delivery-contract'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { prepareHandoffRoutes } from '../backoffice/handoff-route-prepare'

export async function applySessionHandoffRouting(
  rule: SessionFollowUpRule,
  workspacePath: string,
  chainId?: string,
  connectionId?: string
): Promise<SessionFollowUpRule> {
  const pins = rule.files ?? []
  // Why: route preparation uses local filesystem/git APIs and cannot own an SSH host's files.
  if (connectionId || !chainId || rule.includeWorkingTree !== true) {
    return rule
  }
  const result = await prepareHandoffRoutes({
    workspacePath,
    branch: handoffBranchName(chainId),
    label: rule.taskTitle || rule.sessionLabel,
    memo: rule.note,
    pins: [],
    next: 'person',
    sameWorktree: false,
    includeWorkingTree: true
  })
  if (!result.ok) {
    throw new FollowUpException('upload-failed', '', result.error.message)
  }
  const prepared = result.data
  if (prepared.refused.length) {
    throw new FollowUpException(
      'file-too-large',
      prepared.refused.map((entry) => entry.name).join(', '),
      prepared.refused.map((entry) => entry.reason).join(' ')
    )
  }
  const appendMemo = (text: string): string =>
    prepared.memoLines.length ? [text, '', ...prepared.memoLines].join('\n').slice(0, 8192) : text
  return {
    ...rule,
    note: appendMemo(rule.note),
    // Why: delivery prefers the conversation's request description over the saved note.
    ...(rule.request
      ? { request: { ...rule.request, description: appendMemo(rule.request.description) } }
      : {}),
    files: [...pins, ...prepared.pins]
  }
}
