import type { AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type {
  BuildReviewWorkerSnapshot,
  BuildReviewWorkerStatus
} from '../../../../shared/build-review-pipeline'
import { isCommandToolName } from '../../../../shared/native-chat-tool-activity'

/**
 * The agent-hook row of a worker's terminal. Workers run in real agent terminals, so their live
 * state (tool, message, since when) is already in the store; this finds it by terminal handle.
 * Returns the store's own row object, so a selector built on it stays referentially stable.
 */
export function findWorkerStatusRow(
  rows: Record<string, AgentStatusEntry> | undefined,
  handle: string | null
): AgentStatusEntry | null {
  if (!rows || !handle) {
    return null
  }
  let found: AgentStatusEntry | null = null
  for (const row of Object.values(rows)) {
    // Why the newest: a relaunched pane can leave an older row carrying the same handle.
    if (row.terminalHandle === handle && (!found || row.updatedAt > found.updatedAt)) {
      found = row
    }
  }
  return found
}

/** Whether the card should follow the worker live: it has started and has not reported. */
export function isWorkerLive(worker: BuildReviewWorkerSnapshot): boolean {
  return worker.status === 'starting' || worker.status === 'running'
}

/**
 * The status the card names: a start the host is still confirming reads Running once the agent's
 * hooks say it is working (that can go on for minutes). A startup question keeps it Starting.
 */
export function workerDisplayStatus(
  worker: BuildReviewWorkerSnapshot,
  row: AgentStatusEntry | null
): BuildReviewWorkerStatus {
  return worker.status === 'starting' && !worker.startupBlocker && row?.state === 'working'
    ? 'running'
    : worker.status
}

export function workerDotState(
  worker: BuildReviewWorkerSnapshot,
  row: AgentStatusEntry | null
): AgentDotState {
  switch (worker.status) {
    case 'pending':
      return 'idle'
    case 'succeeded':
      return 'done'
    case 'failed':
      return 'failed'
    case 'starting':
    case 'running':
      break
  }
  // A startup question in its terminal: the worker waits on the person, whatever its hooks say.
  if (worker.startupBlocker) {
    return 'blocked'
  }
  if (!row) {
    return 'working'
  }
  // Why failed first: a provider error or rate limit ends the turn as a `done` flagged failed,
  // and the worker then sits there without reporting; it must not look finished.
  if (row.failed === true) {
    return 'failed'
  }
  if (row.interrupted === true) {
    return 'interrupted'
  }
  switch (row.state) {
    case 'working':
      return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'blocked':
    case 'waiting':
      return row.state
    case 'done':
      // Why idle, not done: the turn ended but the worker has not reported, so the run is still
      // waiting on it; a check mark would contradict the Running badge beside it.
      return 'idle'
  }
}

type ToolVerb = 'edit' | 'read' | 'search' | 'fetch'

const TOOL_VERBS: Record<string, ToolVerb> = {
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  apply_patch: 'edit',
  applypatch: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',
  create_file: 'edit',
  write_file: 'edit',
  edit_file: 'edit',
  replace: 'edit',
  notebookedit: 'edit',
  read: 'read',
  read_file: 'read',
  read_many_files: 'read',
  view: 'read',
  notebookread: 'read',
  grep: 'search',
  glob: 'search',
  ls: 'search',
  list_directory: 'search',
  search: 'search',
  search_file_content: 'search',
  find: 'search',
  websearch: 'search',
  web_search: 'search',
  google_web_search: 'search',
  webfetch: 'fetch',
  web_fetch: 'fetch',
  fetch: 'fetch'
}

// The worker's own `<cli> orchestration <verb>` call, however the CLI path is quoted.
const ORCHESTRATION_COMMAND =
  /(?:^|[\s"'/\\])(?:omni-dev|omni|orca)(?:\.exe|\.cmd)?["']?\s+orchestration\s+([a-z][a-z-]*)/i

/**
 * What a worker's orchestration call means for the run, in words. Why: the raw command is an
 * app-internal CLI path, its flags and terminal ids; the person only needs what it is doing.
 */
function orchestrationActivity(verb: string, role: string): string {
  switch (verb.toLowerCase()) {
    case 'send':
    case 'report':
    case 'worker-done':
      return role === 'reviewer'
        ? translate('buildReview.live.sendingReview', 'Sending the review…')
        : translate('buildReview.live.sendingReport', 'Sending its report…')
    case 'ask':
      return translate('buildReview.live.askingQuestion', 'Asking you a question…')
    case 'check':
      return translate('buildReview.live.checkingMessages', 'Checking for messages…')
    default:
      return translate('buildReview.live.updatingRun', 'Updating the run…')
  }
}

/** The tool a working agent is using, as a sentence: "Editing src/a.ts", "Running pnpm test". */
function toolActivity(toolName: string, target: string, role: string): string {
  if (isCommandToolName(toolName)) {
    const orchestration = ORCHESTRATION_COMMAND.exec(target)?.[1]
    if (orchestration) {
      return orchestrationActivity(orchestration, role)
    }
    return target
      ? translate('buildReview.live.runningCommand', 'Running {{target}}', { target })
      : translate('buildReview.live.runningShell', 'Running a command')
  }
  const verb: ToolVerb | undefined = TOOL_VERBS[toolName.toLowerCase()]
  switch (verb) {
    case 'edit':
      return target
        ? translate('buildReview.live.editing', 'Editing {{target}}', { target })
        : translate('buildReview.live.editingFiles', 'Editing files')
    case 'read':
      return target
        ? translate('buildReview.live.reading', 'Reading {{target}}', { target })
        : translate('buildReview.live.readingFiles', 'Reading files')
    case 'search':
      return target
        ? translate('buildReview.live.searching', 'Searching {{target}}', { target })
        : translate('buildReview.live.searchingFiles', 'Searching the workspace')
    case 'fetch':
      return target
        ? translate('buildReview.live.fetching', 'Fetching {{target}}', { target })
        : translate('buildReview.live.fetchingPage', 'Fetching a page')
    case undefined:
      return target
        ? translate('buildReview.live.usingToolOn', 'Running {{toolName}} {{target}}', {
            toolName,
            target
          })
        : translate('buildReview.live.usingTool', 'Running {{toolName}}', { toolName })
  }
}

/** One line of what the worker is doing now, from its hook row; null once it has reported. */
export function workerActivity(
  worker: BuildReviewWorkerSnapshot,
  row: AgentStatusEntry | null
): string | null {
  if (!isWorkerLive(worker)) {
    return null
  }
  if (worker.startupBlocker) {
    return translate('buildReview.live.waitingOnYou', 'Waiting for your answer in its terminal')
  }
  if (!row) {
    return worker.status === 'starting'
      ? translate('buildReview.live.starting', 'Starting the agent…')
      : translate('buildReview.live.working', 'Working')
  }
  const toolName = row.toolName?.trim() ?? ''
  const target = (row.toolInput?.trim() ?? '').split(/\r?\n/)[0]!.trim()
  switch (row.state) {
    case 'working':
      return toolName
        ? toolActivity(toolName, target, worker.role)
        : translate('buildReview.live.thinking', 'Thinking')
    case 'waiting':
      return toolName
        ? translate('buildReview.live.permissionFor', 'Waiting for permission: {{toolName}}', {
            toolName
          })
        : translate('buildReview.live.permission', 'Waiting for permission')
    case 'blocked':
      return translate('buildReview.live.blocked', 'Needs your input in its terminal')
    case 'done':
      return turnEnded(row)
  }
}

/** A worker whose turn ended without a report: failed, interrupted, or simply between turns. */
function turnEnded(row: AgentStatusEntry): string {
  if (row.failed === true) {
    const reason = row.failureReason?.trim()
    return reason
      ? translate('buildReview.live.turnFailedReason', 'Its last turn failed: {{reason}}', {
          reason
        })
      : translate('buildReview.live.turnFailed', 'Its last turn failed; check its terminal')
  }
  if (row.interrupted === true) {
    return translate(
      'buildReview.live.turnInterrupted',
      'Its last turn was interrupted; check its terminal'
    )
  }
  return translate('buildReview.live.turnDone', 'Finished a turn; waiting for its report')
}

/** The worker's latest words, when they are its own prose rather than a tool's output. */
export function workerMessagePreview(row: AgentStatusEntry | null): string | null {
  if (!row || row.lastAssistantMessageIsToolOutput) {
    return null
  }
  const message = row.lastAssistantMessage?.trim() || row.lastCompletedAssistantMessage?.trim()
  return message || null
}

/** Compact elapsed time: 45s, 3m 05s, 1h 02m. */
export function formatWorkerElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) {
    return translate('buildReview.live.elapsedSeconds', '{{seconds}}s', { seconds })
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return translate('buildReview.live.elapsedMinutes', '{{minutes}}m {{seconds}}s', {
      minutes,
      seconds: String(seconds % 60).padStart(2, '0')
    })
  }
  return translate('buildReview.live.elapsedHours', '{{hours}}h {{minutes}}m', {
    hours: Math.floor(minutes / 60),
    minutes: String(minutes % 60).padStart(2, '0')
  })
}
