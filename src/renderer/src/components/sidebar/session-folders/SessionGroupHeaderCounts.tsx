import { useMemo } from 'react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { translate } from '@/i18n/i18n'
import type { SessionFolderTally as Tally } from '@/lib/session-folder-rollup'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import { useSessionFolders } from '@/store/session-folders'
import { SessionFolderTally } from './SessionFolderTally'
import { SessionGroupParityBadges } from './SessionGroupParityBadges'
import { SessionProjectRollup } from './SessionProjectRollup'
import { useSessionGroupParityCounts } from './session-group-parity'
import { SessionSubfolderMark, sessionSubfolderCount } from './SessionSubfolderMark'
import { SessionTaskGroupCounts } from './SessionTaskGroupCounts'

/** The counts after a group's name: a folder's tally, or its row count and working/asking badges. */
export function SessionGroupHeaderCounts({
  group,
  folders,
  tally,
  activeCount,
  listedCount
}: {
  group: SessionSidebarGroup
  folders: readonly SessionFolder[]
  tally: Tally | null
  activeCount: number
  listedCount: number
}): React.JSX.Element {
  const folderId = group.kind === 'folder' ? group.folder?.id : undefined
  const isProject = useSessionFolders((state) =>
    Boolean(folderId && state.metadata.projects?.[folderId])
  )
  // Session parity (step 8): the headline is what the rows' owners list; the rest read apart.
  // Why own and nested rows: `listedCount` counts the subtree (childRowCount), so the rows read
  // apart must come from the same subtree, or a parent would headline a nested "only here" row.
  const counted = useMemo(
    () => (group.nestedRows?.length ? [...group.rows, ...group.nestedRows] : group.rows),
    [group.nestedRows, group.rows]
  )
  const parity = useSessionGroupParityCounts(counted)
  const headline = listedCount - parity.onlyHere - parity.held
  return (
    <>
      {group.taskCounts ? <SessionTaskGroupCounts counts={group.taskCounts} /> : null}
      {/* Why on every heading, a folder's tally and a project's rollup included: the two
          computers' owner-listed numbers must agree wherever a heading counts, and what is listed
          only here must read apart there too (a lens or folder group always carries a tally). */}
      <span
        data-session-group-listed-count={headline}
        className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
      >
        {headline}
      </span>
      <SessionGroupParityBadges {...parity} />
      {tally && isProject ? (
        <SessionProjectRollup tally={tally} />
      ) : tally ? (
        <SessionFolderTally tally={tally} />
      ) : null}
      <SessionSubfolderMark count={sessionSubfolderCount(group, folders)} />
      {/* Why not with a tally: it already says how many work and how many need you. */}
      {!tally && activeCount > 0 ? (
        <span
          data-session-group-active-count={activeCount}
          aria-label={translate('conversations.groupWorking', '{{count}} working', {
            count: activeCount
          })}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-session-tone-active/15 px-1.5 text-[10px] font-semibold tabular-nums leading-4 text-session-tone-active"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {activeCount}
        </span>
      ) : null}
      {!tally && group.kind !== 'attention' && group.kind !== 'task' && group.attentionCount > 0 ? (
        <span
          data-session-group-attention-count={group.attentionCount}
          aria-label={translate(
            'auto.components.SessionSidebar.groupNeedsYou',
            '{{count}} need you',
            { count: group.attentionCount }
          )}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-agent-question/15 px-1.5 text-[10px] font-semibold tabular-nums leading-4 text-agent-question-text"
        >
          <AgentQuestionIcon className="size-2.5" />
          {group.attentionCount}
        </span>
      ) : null}
    </>
  )
}
