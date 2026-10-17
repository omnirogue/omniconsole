import type { SessionFollowUpDraft } from '@/lib/session-follow-up-commands'
import type { FollowUpIntent } from '../../../../shared/session-follow-up-parser'
import { resolveWorkspaceOutputPath } from '../../../../shared/session-follow-up-deliverables'
import {
  SESSION_FOLLOW_UP_MAX_FILES,
  SESSION_FOLLOW_UP_MAX_RECIPIENTS,
  type SessionFollowUpAction,
  type SessionFollowUpRule
} from '../../../../shared/session-follow-up-rule'
import {
  resolveRosterName,
  type RosterNameMatch,
  type TeamRosterPerson
} from '../../../../shared/team-roster-search'

/**
 * The Next step form as plain data. The sentence box fills it through
 * `applyFollowUpIntent`, the controls edit it directly, and both save through
 * `followUpDraftFromForm`, so the two entry paths persist the same rule.
 */
export type FollowUpTask = { id: string; title: string }

export type FollowUpFormContext = {
  workspacePath: string
  /** The run manifest this session was told to write, when OmniConsole launched it. */
  manifestPath: string | null
  /** The workspace's linked OmniOS task, when it has one. */
  linkedTask: FollowUpTask | null
  /** Card-less handoffs are on: a request without a task is allowed. */
  cardlessHandoffs?: boolean
}

export type FollowUpFormState = {
  /** What people are asked for; null lets the work say it. */
  action: SessionFollowUpAction | null
  people: TeamRosterPerson[]
  deliverableMode: 'manifest' | 'files'
  manifestPath: string | null
  /** One output path per line, relative to the workspace or absolute inside it. */
  filesText: string
  includeSummary: boolean
  note: string
  /** A datetime-local value, or empty. */
  due: string
  task: FollowUpTask | null
}

export type FollowUpProblem =
  | { kind: 'person-choice'; match: Extract<RosterNameMatch, { kind: 'choice' }> }
  | { kind: 'person-unknown'; query: string }
  | { kind: 'no-people' }
  | { kind: 'too-many-people' }
  | { kind: 'no-task' }
  | { kind: 'no-files' }
  | { kind: 'final-needs-files' }
  | { kind: 'file-outside'; path: string }
  | { kind: 'too-many-files' }

function toLocalInput(iso: string): string {
  const local = new Date(iso)
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset())
  return local.toISOString().slice(0, 16)
}

function workspaceRelative(workspacePath: string, path: string): string {
  const root = workspacePath.replace(/[\\/]+$/, '')
  return path.startsWith(root) && /[\\/]/.test(path.charAt(root.length))
    ? path.slice(root.length + 1)
    : path
}

export function initialFollowUpForm(context: FollowUpFormContext): FollowUpFormState {
  return {
    action: null,
    people: [],
    deliverableMode: context.manifestPath ? 'manifest' : 'files',
    manifestPath: context.manifestPath,
    filesText: '',
    includeSummary: false,
    note: '',
    due: '',
    task: context.linkedTask
  }
}

/** Prefill an edit from the saved rule; the saved task and manifest stay as they were. */
export function formFromRule(
  rule: SessionFollowUpRule,
  context: FollowUpFormContext
): FollowUpFormState {
  const manifest = rule.deliverables.kind === 'manifest' ? rule.deliverables.manifestPath : null
  const paths = rule.deliverables.kind === 'files' ? rule.deliverables.paths : []
  return {
    action: rule.action ?? null,
    people: rule.recipients.map((recipient) => ({
      id: recipient.employeeId,
      name: recipient.name
    })),
    deliverableMode: manifest ? 'manifest' : 'files',
    manifestPath: manifest ?? context.manifestPath,
    filesText: paths.map((path) => workspaceRelative(context.workspacePath, path)).join('\n'),
    includeSummary: rule.includeSummary,
    note: rule.note,
    due: rule.dueAt ? toLocalInput(rule.dueAt) : '',
    task: rule.taskId ? { id: rule.taskId, title: rule.taskTitle } : null
  }
}

/** Fill the form from a sentence; what the sentence does not say keeps its current value. */
export function applyFollowUpIntent(
  form: FollowUpFormState,
  intent: FollowUpIntent,
  roster: readonly TeamRosterPerson[],
  context: FollowUpFormContext
): { form: FollowUpFormState; problems: FollowUpProblem[] } {
  const problems: FollowUpProblem[] = []
  const people = [...form.people]
  for (const name of intent.recipientNames) {
    const match = resolveRosterName(name, roster)
    if (match.kind === 'match') {
      if (!people.some((person) => person.id === match.person.id)) {
        people.push(match.person)
      }
    } else if (match.kind === 'choice') {
      problems.push({ kind: 'person-choice', match })
    } else {
      problems.push({ kind: 'person-unknown', query: name })
    }
  }
  let { deliverableMode, filesText } = form
  if (intent.deliverables?.kind === 'files') {
    deliverableMode = 'files'
    filesText = intent.deliverables.names.join('\n')
  } else if (intent.deliverables?.kind === 'final') {
    if (form.manifestPath ?? context.manifestPath) {
      deliverableMode = 'manifest'
    } else if (!filesText.trim()) {
      problems.push({ kind: 'final-needs-files' })
    }
  }
  return {
    form: {
      ...form,
      action: intent.action ?? form.action,
      people,
      deliverableMode,
      filesText,
      includeSummary: form.includeSummary || intent.includeSummary,
      due: intent.due ? toLocalInput(intent.due.at) : form.due
    },
    problems
  }
}

/** The draft both entry paths save, or everything that still stops it. */
export function followUpDraftFromForm(
  form: FollowUpFormState,
  context: FollowUpFormContext
): { draft: SessionFollowUpDraft | null; problems: FollowUpProblem[] } {
  const problems: FollowUpProblem[] = []
  if (form.people.length === 0) {
    problems.push({ kind: 'no-people' })
  } else if (form.people.length > SESSION_FOLLOW_UP_MAX_RECIPIENTS) {
    problems.push({ kind: 'too-many-people' })
  }
  if (!form.task && !context.cardlessHandoffs) {
    problems.push({ kind: 'no-task' })
  }
  let deliverables: SessionFollowUpDraft['deliverables']
  if (form.deliverableMode === 'manifest' && form.manifestPath) {
    deliverables = { kind: 'manifest', manifestPath: form.manifestPath }
  } else {
    const paths: string[] = []
    for (const line of form.filesText.split(/\r?\n/).map((entry) => entry.trim())) {
      if (!line) {
        continue
      }
      const resolved = resolveWorkspaceOutputPath(context.workspacePath, line)
      if (!resolved) {
        problems.push({ kind: 'file-outside', path: line })
      } else if (!paths.includes(resolved)) {
        paths.push(resolved)
      }
    }
    if (paths.length > SESSION_FOLLOW_UP_MAX_FILES) {
      problems.push({ kind: 'too-many-files' })
    }
    if (
      paths.length === 0 &&
      !form.includeSummary &&
      !problems.some((problem) => problem.kind === 'file-outside')
    ) {
      problems.push({ kind: 'no-files' })
    }
    deliverables = { kind: 'files', paths }
  }
  if (problems.length > 0) {
    return { draft: null, problems }
  }
  return {
    draft: {
      taskId: form.task?.id ?? null,
      taskTitle: form.task?.title ?? '',
      recipients: form.people.map((person) => ({ employeeId: person.id, name: person.name })),
      ...(form.action ? { action: form.action } : {}),
      deliverables,
      includeSummary: form.includeSummary,
      note: form.note,
      ...(form.due ? { dueAt: new Date(form.due).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {})
    },
    problems
  }
}
