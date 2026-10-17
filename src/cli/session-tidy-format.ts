import type {
  SessionTidyAction,
  SessionTidyGroup,
  SessionTidyReport,
  SessionTidyResult,
  SessionTidyRow
} from '../shared/session-manage-types'

const TIDY_GROUPS: readonly { action: SessionTidyAction; heading: string }[] = [
  { action: 'archive', heading: 'Archive' },
  { action: 'delete', heading: 'Delete' },
  { action: 'hold', heading: 'Hold (an unfinished recorded commitment)' },
  { action: 'skip', heading: 'Skip' }
]

const DELETE_GROUP_HEADINGS: Partial<Record<SessionTidyAction, string>> = {
  hold: 'Keep: an unfinished recorded commitment',
  skip: 'Keep'
}

function formatTidyRow(row: SessionTidyRow): string[] {
  const outcome =
    row.outcome === 'archived' || row.outcome === 'deleted'
      ? row.outcome
      : row.outcome
        ? `${row.outcome}: ${row.outcomeReason ?? ''}`.trim()
        : null
  const where = row.paneKey ? `pane ${row.paneKey}` : `tab ${row.tabId ?? '(none)'}`
  return [
    `  ${[row.title, row.state, row.verdict, row.folder ?? 'unfiled'].join(' · ')} — ${row.reason}`,
    `    ${where}${outcome ? `  ${outcome}` : ''}`,
    ...(row.auditError ? [`    audit warning: ${row.auditError}`] : [])
  ]
}

function tidySummary(result: SessionTidyResult): string {
  const { counts, applied } = result
  const deleting = result.mode === 'delete'
  const head = applied
    ? [
        deleting ? `Deleted ${applied.deleted ?? 0}` : `Archived ${applied.archived}`,
        applied.skipped ? `${applied.skipped} changed and skipped` : null,
        applied.failed ? `${applied.failed} failed` : null
      ]
    : [deleting ? `Would delete ${counts.delete ?? 0}` : `Would archive ${counts.archive}`]
  const kept = deleting ? [`keeping ${counts.hold + counts.skip}`] : []
  return [
    ...head,
    ...(deleting ? kept : [`holding ${counts.hold}`, `skipping ${counts.skip}`]),
    `${counts.junkTitles} junk title${counts.junkTitles === 1 ? '' : 's'}`
  ]
    .filter(Boolean)
    .join(' · ')
}

const TIDY_GROUP_WORDS: Record<SessionTidyGroup, string> = {
  'already-archived': 'Already archived',
  'launch-pending': 'Launch still pending',
  'other-omniconsole':
    'Runs on another OmniConsole: tidy cannot verify or archive it from this computer',
  'host-disconnected': 'Its host is disconnected, so it cannot be verified',
  'ssh-host': 'Runs on an SSH host: tidy acts on this computer only',
  unverifiable: 'No readable terminal attached on this computer, so it cannot be verified',
  'unknown-state': 'State unknown, so it is kept',
  pinned: 'Pinned',
  saved: 'Saved',
  busy: 'Working, queued, provider-limited or waiting on the person',
  'open-items': 'Idle, but with pending steps, a queue or something waiting',
  held: 'Held by an unfinished recorded commitment (name it with --include to archive it)',
  routine: 'A routine runs in it',
  'background-not-in-window':
    'Running in the background, not in a window: open it with omni session show, or end it with omni terminal close; tidy ends it only when named with --delete',
  'workflow-draft': 'A workflow not started yet (a draft, or its Start is still being sent)',
  'workflow-active':
    'A workflow run still running or waiting on the person: tidy never cancels a run',
  'workflow-run-not-found':
    'Run not found: the controller that started the workflow has no such run, so it cannot be verified',
  'workflow-status-unavailable':
    'Status unavailable: the workflow run could not be read, so it cannot be verified',
  'awaiting-answer':
    'Waiting on your decision or your answer to a Question: only you can close or delete it'
}

const tidyRef = ({ paneKey, tabId, title }: SessionTidyRow) => ({ paneKey, tabId, title })

/** An `--apply` run's outcome from its rows; an older host's rows (no group) group by reason. */
export function sessionTidyReport(rows: readonly SessionTidyRow[]): SessionTidyReport {
  const report: SessionTidyReport = { archived: [], changed: [], failed: [], notArchived: [] }
  const groups = new Map<string, SessionTidyReport['notArchived'][number]>()
  for (const row of rows) {
    if (row.outcome === 'archived') {
      report.archived.push(tidyRef(row))
    } else if (row.outcome === 'deleted') {
      ;(report.deleted ??= []).push(tidyRef(row))
    } else if (row.outcome === 'skipped' || row.outcome === 'failed') {
      const bucket = row.outcome === 'skipped' ? report.changed : report.failed
      bucket.push({ ...tidyRef(row), reason: row.outcomeReason ?? row.reason })
    } else if (row.action !== 'archive' && row.action !== 'delete') {
      const key = row.group ?? `other:${row.reason}`
      const group = groups.get(key)
      if (group) {
        group.count += 1
      } else {
        groups.set(key, {
          group: row.group ?? 'other',
          reason: (row.group && TIDY_GROUP_WORDS[row.group]) || row.reason,
          count: 1
        })
      }
    }
  }
  report.notArchived = [...groups.values()].sort((a, b) => b.count - a.count)
  return report
}

function formatTidyReport(result: SessionTidyResult, report: SessionTidyReport): string {
  const deleting = result.mode === 'delete'
  const verb = deleting ? 'deleted' : 'archived'
  const done = deleting ? (report.deleted ?? []) : report.archived
  const ref = (row: { title: string; paneKey: string | null; tabId: string | null }) =>
    `  ${row.title}  ${row.paneKey ? `pane ${row.paneKey}` : `tab ${row.tabId ?? '(none)'}`}`
  const lines = [tidySummary(result)]
  if (done.length) {
    lines.push('', deleting ? 'Deleted:' : 'Archived:', ...done.map(ref))
  }
  if (report.changed.length) {
    lines.push(
      '',
      `Changed since the plan, so not ${verb}:`,
      ...report.changed.map((row) => `${ref(row)} — ${row.reason}`)
    )
  }
  if (report.failed.length) {
    lines.push('', 'Failed:', ...report.failed.map((row) => `${ref(row)} — ${row.reason}`))
  }
  if (report.notArchived.length) {
    lines.push(
      '',
      deleting ? 'Kept, by reason:' : 'Not archived, by reason:',
      ...report.notArchived.map((group) => `  ${group.count} × ${group.reason}`)
    )
  }
  lines.push(
    '',
    done.length
      ? deleting
        ? 'Each delete shows a toast with Undo; a closed tab reopens from Recently closed.'
        : 'Each archive shows a toast with Undo in the OmniConsole window.'
      : `Nothing was ${verb}. Report the reasons above; do not report this cleanup as done.`
  )
  return lines.join('\n')
}

export function formatSessionTidy(result: SessionTidyResult): string {
  if (result.report) {
    return formatTidyReport(result, result.report)
  }
  const deleting = result.mode === 'delete'
  const lines = [tidySummary(result)]
  for (const { action, heading } of TIDY_GROUPS) {
    const rows = result.rows.filter((row) => row.action === action)
    // Already-archived rows are the bulk of a long sidebar; one line says they were left alone.
    const archived =
      action === 'skip' ? rows.filter((row) => row.reason === 'Already archived.') : []
    const shown = rows.filter((row) => !archived.includes(row))
    if (!rows.length) {
      continue
    }
    const title = (deleting && DELETE_GROUP_HEADINGS[action]) || heading
    lines.push('', `${title}:`, ...shown.flatMap(formatTidyRow))
    if (archived.length) {
      lines.push(`  ${archived.length} already archived.`)
    }
  }
  if (result.titleFlags.length) {
    lines.push(
      '',
      'Junk titles (not renamed):',
      ...result.titleFlags.map((flag) => `  “${flag.title}”  pane ${flag.paneKey ?? '(none yet)'}`)
    )
  }
  if (result.dryRun) {
    const pending = deleting ? (result.counts.delete ?? 0) : result.counts.archive
    const unverified = result.rows.some((row) => row.unverified) ? ' --unverified' : ''
    const apply = deleting
      ? `omni session tidy --delete${unverified} --apply`
      : 'omni session tidy --apply'
    lines.push(
      '',
      pending
        ? `Dry run: nothing changed. When the person asks, apply with ${apply} --request "<their words>".`
        : `Dry run: nothing changed, and nothing qualifies for ${deleting ? 'delete' : 'archive'}.`
    )
  }
  return lines.join('\n')
}
