import React from 'react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useNeedsYouCounts } from '@/components/task-page/backoffice/backoffice-needs-you-counts'
import { translate } from '@/i18n/i18n'

/**
 * How many things need this person, from what has already been read. The sidebar
 * uses it for two purposes: the badge, and the rule that a row the person hid is
 * still drawn while it carries something that needs them.
 */
export function useWorkNeedsYouCount(): number {
  const scope = useHandoffScope()
  const { counts } = useNeedsYouCounts(scope, false)
  return counts.total
}

/**
 * The Work group's "need you" badge: the same number the Work home and the Attention
 * summary show. The work feed is not fetched from here; the badge counts what has been read.
 */
export function WorkNeedsYouBadge(): React.JSX.Element | null {
  const scope = useHandoffScope()
  const { counts } = useNeedsYouCounts(scope, false)
  if (counts.total <= 0) {
    return null
  }
  return (
    <span
      aria-label={translate(
        'auto.components.sidebar.SidebarNav.attentionCount',
        '{{count}} need you',
        { count: counts.total }
      )}
      data-work-needs-you-badge={counts.total}
      className="inline-flex items-center gap-1 rounded-full bg-agent-question/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-agent-question-text"
    >
      <AgentQuestionIcon className="size-2.5" />
      {counts.total}
    </span>
  )
}
