import React from 'react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { translate } from '@/i18n/i18n'

export function countAttentionWorktrees(
  worktreeIds: readonly string[] | undefined,
  attentionWorktreeIds: ReadonlySet<string>
): number {
  if (!worktreeIds || attentionWorktreeIds.size === 0) {
    return 0
  }
  let count = 0
  for (const worktreeId of worktreeIds) {
    if (attentionWorktreeIds.has(worktreeId)) {
      count += 1
    }
  }
  return count
}

/** Surfaces "N workspaces need you" on a group header, so a collapsed group still shows the wait. */
export function SectionHeaderAttentionBadge({
  worktreeIds,
  attentionWorktreeIds
}: {
  worktreeIds: readonly string[] | undefined
  attentionWorktreeIds: ReadonlySet<string>
}): React.JSX.Element | null {
  const count = countAttentionWorktrees(worktreeIds, attentionWorktreeIds)
  if (count === 0) {
    return null
  }
  return (
    <span
      data-worktree-header-attention-count={count}
      aria-label={translate(
        'auto.components.sidebar.SectionHeader.needsYouCount',
        '{{count}} need you',
        { count }
      )}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-agent-question/15 px-1.5 text-[10px] font-semibold tabular-nums leading-4 text-agent-question-text"
    >
      <AgentQuestionIcon className="size-2.5" />
      {count}
    </span>
  )
}
