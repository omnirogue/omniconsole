import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { useJunkTitleRepairs } from '@/components/sidebar/session-folders/use-junk-title-repairs'
import {
  dismissJunkTitleNotice,
  isJunkTitleNoticeDismissed,
  junkTitleExample
} from '@/components/sidebar/session-folders/junk-title-repair'
import { translate } from '@/i18n/i18n'
import {
  describeOrganizationTime,
  describeOrganizationWhat,
  describeOrganizationWho
} from '@/lib/session-organization-describe'
import { undoOrganizationChangesWithNotice } from '@/lib/session-organization-undo-notice'
import { renameSessionsFromGoals } from '@/lib/session-title-change'
import { useRecentOrganizationChanges } from '@/lib/use-organization-history'
import { useSessionFolders } from '@/store/session-folders'
import { WorkSectionTitle } from './WorkSectionTitle'
import { stewardActivityGroups, type StewardActivityGroup } from './steward-activity-model'
import { WorkStewardStatus } from './WorkStewardStatus'
import { WorkStewardSuggestions } from './WorkStewardSuggestions'

const GROUP_LIMIT = 6
const LINES_PER_GROUP = 3

function GroupRow({
  group,
  onUndone
}: {
  group: StewardActivityGroup
  onUndone: () => void
}): React.JSX.Element {
  const folders = useSessionFolders((state) => state.metadata.folders)
  const [busy, setBusy] = useState(false)
  return (
    <li
      className="rounded-lg border bg-card px-3 py-2"
      data-steward-group={group.key}
      data-steward-changes={group.records.length}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {group.request
              ? translate('work.steward.asked', '“{{request}}”', { request: group.request })
              : describeOrganizationWho(group.executor)}
          </div>
          <div className="text-xs text-muted-foreground">
            {translate(
              'work.steward.counts',
              '{{changes}} changes · {{sessions}} sessions · last at {{when}}',
              {
                changes: group.records.length,
                sessions: group.targetCount,
                when: describeOrganizationTime(group.latestTs)
              }
            )}
          </div>
        </div>
        {group.undoable.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void undoOrganizationChangesWithNotice(group.undoable, 'work')
                .then(onUndone)
                .finally(() => setBusy(false))
            }}
          >
            {translate('work.steward.undo', 'Undo')}
          </Button>
        ) : null}
      </div>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {group.records.slice(0, LINES_PER_GROUP).map((record) => (
          <li key={record.opId} className="truncate">
            {describeOrganizationWhat(record, folders)}
            {record.reason ? ` · ${record.reason}` : ''}
          </li>
        ))}
        {group.records.length > LINES_PER_GROUP ? (
          <li>
            {translate('work.steward.moreChanges', '{{count}} more', {
              count: group.records.length - LINES_PER_GROUP
            })}
          </li>
        ) : null}
      </ul>
    </li>
  )
}

function GoalTitleOffer(): React.JSX.Element | null {
  const sessions = useSidebarSessions()
  const repairs = useJunkTitleRepairs(sessions)
  const [dismissed, setDismissed] = useState(isJunkTitleNoticeDismissed)
  if (dismissed || repairs.length === 0) {
    return null
  }
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
      data-steward-title-offer=""
    >
      <span className="min-w-0 flex-1">
        {repairs.length === 1
          ? translate(
              'conversations.junkTitles.noticeOne',
              '1 session has a launcher title like {{example}}',
              { example: junkTitleExample(repairs) }
            )
          : translate(
              'conversations.junkTitles.noticeMany',
              '{{count}} sessions have launcher titles like {{example}}',
              { count: repairs.length, example: junkTitleExample(repairs) }
            )}
      </span>
      <Button size="xs" variant="outline" onClick={() => renameSessionsFromGoals(repairs, 'work')}>
        {translate('conversations.junkTitles.rename', 'Rename from their goals')}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          dismissJunkTitleNotice()
          setDismissed(true)
        }}
      >
        {translate('conversations.junkTitles.dismiss', 'Dismiss')}
      </Button>
    </li>
  )
}

/**
 * What agents, launches, sync and the app changed for the person in the last 24 hours, one line
 * per request with Undo for the whole of it; the steward's own report (its moves, Stalled, and
 * Finished since you last looked); plus the offer to rename launcher-titled sessions.
 */
export function WorkStewardActivitySection(): React.JSX.Element {
  const { data, error, reload } = useRecentOrganizationChanges()
  const groups = useMemo(
    () => stewardActivityGroups(data?.entries ?? [], new Set(data?.undoable ?? [])),
    [data]
  )
  return (
    <section
      aria-label={translate('work.steward.title', 'Steward activity')}
      data-work-steward={groups.length}
    >
      <WorkSectionTitle
        title={translate('work.steward.title', 'Steward activity')}
        sub={translate('work.steward.sub', 'Changed for you in the last 24 hours')}
      />
      <WorkStewardStatus />
      <ul className="space-y-1.5">
        <WorkStewardSuggestions onChanged={reload} />
        <GoalTitleOffer />
        {groups.slice(0, GROUP_LIMIT).map((group) => (
          <GroupRow key={group.key} group={group} onUndone={reload} />
        ))}
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {!error && data && groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('work.steward.none', 'Nothing was moved or renamed for you.')}
        </p>
      ) : null}
      {groups.length > GROUP_LIMIT ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'work.steward.moreGroups',
            '{{count}} more; omni session actions lists them all.',
            { count: groups.length - GROUP_LIMIT }
          )}
        </p>
      ) : null}
    </section>
  )
}
