import { sendAfterSession } from './next-step-session-send'
import { refused, sent, newOperationId, type NextStepSendResult } from './next-step-send-result'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import type { HandoffFile } from '../../../../shared/console-handoff-contract'
import {
  nextStepAgents,
  nextStepPeople,
  type NextStepDraft
} from '../../../../shared/next-step-draft'
import { SESSION_FOLLOW_UP_MAX_RECIPIENTS } from '../../../../shared/session-follow-up-rule'
import { launchNextStepAgent } from './next-step-agent-launch'
import { nextStepSubjectTitle, type NextStepSubject } from './next-step-subject'

type CardOrThread = Extract<NextStepSubject, { kind: 'card' | 'thread' }>

export type { NextStepSendResult } from './next-step-send-result'

/**
 * What one open panel remembers between Send clicks: the hub idempotency key minted for
 * each person and who already received the work, so a retry after a partial failure
 * replays the same request instead of opening a second thread.
 */
export type NextStepSendMemory = { operationIds: Map<string, string>; sent: Set<string> }

export function createNextStepSendMemory(): NextStepSendMemory {
  return { operationIds: new Map(), sent: new Set() }
}

const FILE_PINS_MAX = 32

function currentPins(files: readonly HandoffFile[]): { path: string; sha256: string }[] {
  return files
    .filter((file) => file.current && file.available)
    .slice(0, FILE_PINS_MAX)
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
}

async function cardPins(taskId: string): Promise<{ path: string; sha256: string }[]> {
  const files = workflowData(await handoffApi().taskFiles({ taskId })).files
  return files
    .filter((file): file is typeof file & { sha256: string } => !!file.sha256)
    .slice(0, FILE_PINS_MAX)
    .map((file) => ({ path: file.rel, sha256: file.sha256 }))
}

/**
 * People on a card or thread get the hub's own handoff now; the author of a thread gets
 * a reply. Each person keeps one idempotency key for the life of the panel, and a person
 * already sent to is skipped, so a retry after a failure never doubles a thread.
 */
async function sendToPeople(
  subject: CardOrThread,
  draft: NextStepDraft,
  memory: NextStepSendMemory
): Promise<{ sent: string[]; failed: { name: string; message: string } | null }> {
  const people = nextStepPeople(draft).filter((person) => !memory.sent.has(person.key))
  if (people.length === 0) {
    return { sent: [], failed: null }
  }
  const title = nextStepSubjectTitle(subject)
  const note =
    draft.note.trim() ||
    translate('nextStep.defaultCardNote', 'Handed off from OmniConsole: {{title}}.', { title })
  const common = {
    note,
    ...(draft.handoff.communicationType
      ? { communicationType: draft.handoff.communicationType }
      : {}),
    ...(draft.handoff.action ? { action: draft.handoff.action } : {}),
    ...(draft.handoff.dueAt ? { dueAt: draft.handoff.dueAt } : {})
  }
  const fileVersions =
    subject.kind === 'card'
      ? await cardPins(subject.item.task_id)
      : currentPins(subject.detail.files)
  const names: string[] = []
  for (const person of people) {
    const operationId = memory.operationIds.get(person.key) ?? newOperationId()
    memory.operationIds.set(person.key, operationId)
    try {
      await sendToPerson(subject, draft, person, operationId, fileVersions, common)
    } catch (error) {
      return {
        sent: names,
        failed: {
          name: person.name,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
    memory.sent.add(person.key)
    names.push(person.name)
  }
  return { sent: names, failed: null }
}

async function sendToPerson(
  subject: CardOrThread,
  draft: NextStepDraft,
  person: { id: string; name: string },
  operationId: string,
  fileVersions: { path: string; sha256: string }[],
  common: {
    note: string
    action?: NextStepDraft['handoff']['action']
    dueAt?: string
    communicationType?: NextStepDraft['handoff']['communicationType']
  }
): Promise<void> {
  const title = nextStepSubjectTitle(subject)
  if (subject.kind === 'thread' && person.id === subject.detail.thread.author_employee_id) {
    workflowData(
      await handoffApi().respond({
        threadId: subject.detail.thread.id,
        kind: 'reply',
        note: common.note,
        operationId
      })
    )
  } else if (subject.kind === 'thread') {
    // Why: the console relay requires an action on a forward; the thread's own ask carries on, and
    // a thread that never asked for anything specific asks the next person to review.
    workflowData(
      await handoffApi().forward({
        threadId: subject.detail.thread.id,
        recipient: person.id,
        fileVersions,
        operationId,
        ...common,
        action: draft.handoff.action ?? subject.detail.thread.action ?? 'review'
      })
    )
  } else {
    workflowData(
      await handoffApi().send({
        taskId: subject.item.task_id,
        title: title.slice(0, 160),
        recipient: person.id,
        fileVersions,
        operationId,
        ...common
      })
    )
  }
}

/** ＋ Send: agents and people get the work through the paths the subject already has. */
export async function sendNextStep(
  subject: NextStepSubject,
  draft: NextStepDraft,
  memory: NextStepSendMemory = createNextStepSendMemory()
): Promise<NextStepSendResult> {
  if (draft.recipients.length === 0) {
    return refused(translate('nextStep.summaryEmpty', 'Choose who gets this next.'), [
      { kind: 'no-recipients' }
    ])
  }
  if (subject.kind === 'session') {
    return sendAfterSession(subject, draft)
  }
  if (draft.after.length > 0 || draft.placement || draft.end === 'done') {
    // Why: this path launches one agent and reads nothing else; reporting success would lie.
    return refused(
      translate(
        'nextStep.taskPlanUnavailable',
        'Later steps, an ending and another computer can only be set from a running conversation.'
      )
    )
  }
  const agents = nextStepAgents(draft)
  if (agents.length > 1) {
    return refused(
      translate(
        'nextStep.taskParallelUnavailable',
        'Choose one agent to continue this task. Parallel agents can be added from an active conversation.'
      )
    )
  }
  const missing = agents.find((agent) => !agent.presetId && !agent.instructions.trim())
  if (missing) {
    return refused(translate('nextStep.incomplete', 'A few things still need choosing.'), [
      { kind: 'agent-needs-action', key: missing.key }
    ])
  }
  if (nextStepPeople(draft).length > SESSION_FOLLOW_UP_MAX_RECIPIENTS) {
    return refused(
      translate('sessionFollowUp.tooManyPeople', 'One next step goes to at most 20 people.'),
      [{ kind: 'too-many-people' }]
    )
  }
  let outcome: Awaited<ReturnType<typeof sendToPeople>>
  try {
    outcome = await sendToPeople(subject, draft, memory)
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
  const sentLine =
    outcome.sent.length > 0
      ? translate('nextStep.sentToPeople', 'Sent to {{names}}.', { names: outcome.sent.join(', ') })
      : null
  if (outcome.failed) {
    // Why: what already left is said; Send again picks up with the people still waiting.
    return refused(
      [
        sentLine,
        translate(
          'nextStep.sendFailedFor',
          'Sending to {{name}} failed: {{message}}',
          outcome.failed
        )
      ]
        .filter((part): part is string => !!part)
        .join(' ')
    )
  }
  const [agent] = agents
  const operationId = agent ? (memory.operationIds.get(agent.key) ?? newOperationId()) : ''
  if (agent) {
    memory.operationIds.set(agent.key, operationId)
  }
  const launched = agent ? launchNextStepAgent(subject, agent, operationId) : null
  if (launched && !launched.ok) {
    return refused([sentLine, launched.message].filter((part): part is string => !!part).join(' '))
  }
  const parts = [sentLine, launched?.message ?? null].filter((part): part is string => !!part)
  return sent(parts.join(' '))
}
