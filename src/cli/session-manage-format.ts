export { formatSessionTidy, sessionTidyReport } from './session-tidy-format'
import type {
  SessionConflictsResult,
  SessionConflictWorktree,
  SessionManageActionResult,
  SessionManageAnswerResult,
  SessionManageAskResult,
  SessionManageEntry,
  SessionManageListResult,
  SessionStateBasis
} from '../shared/session-manage-types'
import type { SessionProjectThreadStatus } from '../shared/session-project-thread-status'
import type { SessionShowResult } from '../shared/session-show'
import { formatParityBucket, formatParityPopulation } from './session-parity-format'

const INFERRED_BASIS: Partial<Record<SessionStateBasis, string>> = {
  'last-report': 'its last report',
  screen: 'its screen',
  title: 'its title'
}

/** The project page's labels (docs/plans/projects-backend.md §3). */
export const PROJECT_STATUS_LABEL: Record<SessionProjectThreadStatus, string> = {
  working: 'working',
  needsYou: 'waiting on you',
  reviewReady: 'ready for review',
  waiting: 'waiting',
  stopped: 'failed',
  cantSee: "can't see",
  done: 'completed'
}

function backgroundLine(entry: SessionManageEntry): string {
  const open = entry.paneKey
    ? `omni session show --pane ${entry.paneKey}`
    : `omni terminal focus --terminal ${entry.terminal ?? '(none)'}`
  const end = entry.terminal ? `; end it: omni terminal close --terminal ${entry.terminal}` : ''
  return `  running in the background, not in a window — open it: ${open}${end}`
}

function formatEntry(entry: SessionManageEntry): string {
  const basis = INFERRED_BASIS[entry.stateBasis]
  const head = [
    basis ? `${entry.state} (from ${basis})` : entry.state,
    entry.verdict,
    entry.title,
    entry.agent,
    entry.folder ?? 'unfiled',
    entry.projectCoordinator ? 'project chat' : null,
    entry.projectStatus ? `project: ${PROJECT_STATUS_LABEL[entry.projectStatus]}` : null,
    entry.archived ? 'archived' : null,
    entry.pinned ? 'pinned' : null,
    entry.keepGoing ? 'keep going on' : null,
    entry.queueLength ? `${entry.queueLength} queued` : null
  ]
    .filter(Boolean)
    .join(' · ')
  const where = [
    `pane ${entry.paneKey ?? '(none yet)'}`,
    entry.terminal ? `terminal ${entry.terminal}` : null,
    entry.workspace,
    `host ${entry.hostId ?? 'unknown'}`,
    formatParityBucket(entry)
  ]
    .filter(Boolean)
    .join('  ')
  return [
    head,
    `  ${where}`,
    entry.placement === 'background-not-in-window' ? backgroundLine(entry) : null,
    entry.waitingOn ? `  waiting on: ${entry.waitingOn}` : null,
    entry.stalled ? `  stalled: ${entry.stalled.reason}` : null,
    entry.waitedOnBy?.length ? `  waited on by: ${entry.waitedOnBy.join(', ')}` : null,
    ...(entry.ask
      ? [
          `  ${entry.ask.kind}: ${entry.ask.text}`,
          ...entry.ask.options.map(({ n, label }) => `    ${n}. ${label}`),
          `  fingerprint: ${entry.ask.fingerprint}`
        ]
      : []),
    ...entry.pendingSteps.map((step, index) => `  ${index + 1}. ${step}`)
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

export function formatSessionList(result: SessionManageListResult): string {
  const project = result.scope?.project
  const entries = result.sessions.length
    ? result.sessions.map(formatEntry).join('\n')
    : project
      ? `No matching threads in “${project.path}” in this controller’s sidebar.`
      : 'No matching conversations in this controller’s sidebar.'
  const archive = result.scope?.includeArchived
    ? 'Archived rows included.'
    : 'Archived coverage excluded or unspecified.'
  const background =
    result.scope?.backgroundTerminals === 'listed'
      ? 'Runtime-owned terminals no window shows are listed as running in the background.'
      : result.scope?.backgroundTerminals === 'unavailable'
        ? 'Background terminals could not be checked (the window has not published its sessions).'
        : 'Background terminals without a sidebar row are outside this inventory.'
  const scope = `Scope: controller sidebar${project ? `, threads of the project “${project.path}”` : ''}. ${archive} ${background} Other controllers and transcript history are outside this inventory.`
  // Session parity (C5): the unfiltered population, reported apart from the filtered rows above.
  return [entries, scope, ...(result.parity ? formatParityPopulation(result.parity) : [])].join(
    '\n'
  )
}

export function formatSessionAction(result: SessionManageActionResult): string {
  return [
    result.summary,
    result.sent ? `sent: ${result.sent}` : null,
    result.auditError ? `warning: ${result.auditError}` : null
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

export function formatSessionAsk(result: SessionManageAskResult): string {
  if (result.outcome === 'answered') {
    return [result.reply ?? '', result.auditError ? `warning: ${result.auditError}` : null]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
  return [
    formatSessionAction(result),
    result.failure ? `reason: ${result.failure}` : null,
    result.note ?? null
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

export function formatSessionAnswer(result: SessionManageAnswerResult): string {
  return [
    formatSessionAction(result),
    `${result.ask.kind}: ${result.ask.text}`,
    `answer: ${result.chosen.n ? `${result.chosen.n}. ` : ''}${result.chosen.label}`,
    `fingerprint: ${result.ask.fingerprint}`
  ].join('\n')
}

function describeWorktree(worktree: SessionConflictWorktree): string {
  const sessions = worktree.sessions.map((session) => `“${session.title}”`).join(', ')
  return `${worktree.branch ?? '(no branch)'} ${worktree.path ?? worktree.worktreeId} — ${sessions}`
}

export function formatSessionConflicts(result: SessionConflictsResult): string {
  const lines: string[] = []
  for (const repo of result.repos) {
    lines.push(repo.repo)
    for (const file of repo.sharedFiles) {
      lines.push(`  ${file.path} changed in ${file.worktrees.length} worktrees:`)
      lines.push(...file.worktrees.map((worktree) => `    ${describeWorktree(worktree)}`))
    }
    for (const shared of repo.sharedWorktrees) {
      lines.push(
        `  ${shared.sessions.length} live sessions share one worktree: ${describeWorktree(shared)}`
      )
      if (shared.files.length) {
        lines.push(`    changed: ${shared.files.join(', ')}`)
      }
    }
  }
  if (!lines.length) {
    lines.push(
      `No conflicts across ${result.checkedWorktrees} checked worktree${result.checkedWorktrees === 1 ? '' : 's'}.`
    )
  }
  for (const skipped of result.skipped) {
    lines.push(`skipped ${skipped.path ?? skipped.worktreeId}: ${skipped.reason}`)
  }
  return lines.join('\n')
}

export function formatSessionShow(result: SessionShowResult): string {
  const where = result.target ? `pane ${result.target.paneKey ?? '(none yet)'}` : null
  return [result.summary, where].filter(Boolean).join('\n')
}
