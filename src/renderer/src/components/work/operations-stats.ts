import { translate } from '@/i18n/i18n'
import { repoTotal, type OpsCompany } from '../../../../shared/console-scorecard-contract'
import { statNumber as number, type Stat } from './stats-model'

/** How many, or unknown. An absent list is not an empty one. */
function listLength(list: readonly unknown[] | undefined): number | null {
  return list === undefined ? null : list.length
}

/**
 * Operations: projects → objectives → tasks → PRs → QA → deployments → who is
 * working. A repository that reported nothing makes the aggregate unknown rather
 * than a lower bound wearing a total's clothes.
 */

export function operationsStats(operations: OpsCompany | undefined): Stat[] {
  const tasks = operations?.tasks
  const repos = operations?.github
  const blocked = number(tasks?.blocked)
  const approval = number(tasks?.awaiting_approval)
  const capped = 'at least — the list is capped'
  return [
    {
      id: 'live',
      label: translate('work.ops.live', 'Live'),
      value: number(tasks?.live),
      kind: 'count'
    },
    {
      id: 'in_progress',
      label: translate('work.ops.inProgress', 'In progress'),
      value: number(tasks?.in_progress),
      kind: 'count'
    },
    {
      id: 'blocked',
      label: translate('work.ops.blocked', 'Blocked'),
      value: blocked,
      kind: 'count',
      tone: blocked ? 'bad' : 'neutral'
    },
    {
      id: 'awaiting_approval',
      label: translate('work.ops.awaitingApproval', 'Awaiting approval'),
      value: approval,
      kind: 'count',
      tone: approval ? 'warn' : 'neutral'
    },
    {
      id: 'waiting_human',
      label: translate('work.ops.waitingOnAHuman', 'Waiting on a human'),
      // Why the presence check: a list the collector never sent has no length to read,
      // and `0` would claim nobody is waiting when nobody looked.
      value: number(operations?.waiting_on_human_count) ?? listLength(operations?.waiting_on_human),
      kind: 'count',
      caption:
        number(operations?.waiting_on_human_count) === null &&
        operations?.waiting_on_human !== undefined
          ? capped
          : undefined
    },
    {
      id: 'waiting_ai',
      label: translate('work.ops.waitingOnAnAgent', 'Waiting on an agent'),
      value: number(operations?.waiting_on_ai_count) ?? listLength(operations?.waiting_on_ai),
      kind: 'count',
      caption:
        number(operations?.waiting_on_ai_count) === null && operations?.waiting_on_ai !== undefined
          ? capped
          : undefined
    },
    {
      id: 'done_7d',
      label: translate('work.ops.done7d', 'Done 7d'),
      value: number(tasks?.done_7d),
      kind: 'count',
      tone: number(tasks?.done_7d) ? 'good' : 'neutral'
    },
    {
      id: 'projects',
      label: translate('work.ops.projects', 'Projects'),
      value: number(operations?.projects_active),
      kind: 'count',
      caption: translate('work.ops.active', 'active')
    },
    {
      id: 'objectives',
      label: translate('work.ops.objectives', 'Objectives'),
      value: number(operations?.objectives_active),
      kind: 'count',
      caption: translate('work.ops.active', 'active')
    },
    {
      id: 'sessions',
      label: translate('work.ops.agentsWorking', 'Agents working'),
      value: listLength(operations?.sessions_working),
      kind: 'count',
      caption: translate('work.ops.rightNow', 'right now')
    },
    {
      id: 'open_prs',
      label: translate('work.ops.openPullRequests', 'Open pull requests'),
      value: repoTotal(repos, 'open_prs'),
      kind: 'count',
      withheld:
        repoTotal(repos, 'open_prs') === null && (repos?.length ?? 0) > 0
          ? 'One repository reported nothing, so the total is not a total.'
          : undefined
    },
    {
      id: 'merged_7d',
      label: translate('work.ops.merged7d', 'Merged 7d'),
      value: repoTotal(repos, 'merged_7d'),
      kind: 'count'
    },
    {
      id: 'open_issues',
      label: translate('work.ops.openIssues', 'Open issues'),
      value: repoTotal(repos, 'open_issues'),
      kind: 'count'
    },
    {
      id: 'commits_7d',
      label: translate('work.ops.commits7d', 'Commits 7d'),
      value: repoTotal(repos, 'commits_7d'),
      kind: 'count'
    }
  ]
}

/** The rows of one API-cost dimension, largest first, or null when never sent. */
