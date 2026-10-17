import { translate } from '@/i18n/i18n'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import { OMNIOS_WORK_URL } from '../../../../../shared/omnios-task-binding'
import type { NextStepDraft } from '../../../../../shared/next-step-draft'
import type { FleetDispatchReview } from '../fleet-dispatch-types'
import { createNextStepCard } from '../next-step-task-create'
import type { NextStepSubject } from '../next-step-subject'

type Session = Extract<NextStepSubject, { kind: 'session' }>['session']

/** Nothing was dispatched, and why — with the console page that lets a person fix it. */
export type FleetDispatchRefusal = { refusal: string; actionUrl: string | null }

/** The console answers a relative path; the link has to be openable from the desktop. */
function consoleActionUrl(actionUrl: string | undefined): string {
  const trimmed = (actionUrl ?? '').trim()
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed
  }
  return `${OMNIOS_WORK_URL}${trimmed.startsWith('/') ? trimmed : '/work'}`
}

/** No machine means the hub picks one — the "🚀 Dispatch to fleet · automatic" item. */
export type FleetTarget = { machineId: string | null }

export type FleetDispatchPorts = {
  onPrepare: (
    draft: NextStepDraft,
    machineId?: string,
    fanoutAcknowledged?: boolean
  ) => Promise<FleetDispatchReview>
  onDispatch: (review: FleetDispatchReview) => Promise<void>
}

/** "🚀 Fleet" or the host a person picked, for the plan strip. */
export function fleetTargetLabel(target: FleetTarget): string {
  return target.machineId ?? translate('nextStep.fleetAutomaticTarget', 'the fleet · automatic')
}

/**
 * Row 🚀 asks nobody about a card. The conversation's own card is used when it has one,
 * and otherwise one is created for it silently through the same creator the person
 * handoff uses — then the plan is prepared and dispatched in the same click.
 */
export async function dispatchToFleet({
  session,
  draft,
  linkedTask,
  target,
  fanoutAcknowledged,
  ports
}: {
  session: Session
  draft: NextStepDraft
  /** The card this conversation is already tracked by, when it has one. */
  linkedTask: { id: string; title: string } | null
  target: FleetTarget
  /** The operator's own tick for running several agents at once; never assumed. */
  fanoutAcknowledged: boolean
  ports: FleetDispatchPorts
}): Promise<{ warnings: string[] } | FleetDispatchRefusal> {
  const existing = draft.handoff.task ?? linkedTask
  const card = existing ? { task: existing } : await createNextStepCard(session, session.label)
  if ('refusal' in card) {
    return { refusal: card.refusal, actionUrl: card.actionUrl ?? null }
  }
  const planned: NextStepDraft = {
    ...draft,
    handoff: { ...draft.handoff, task: card.task }
  }
  // Why: the console only accepts a fan-out the operator ticked for THIS dispatch; a default
  // computed from the plan would be the desktop consenting on their behalf.
  let review: FleetDispatchReview
  try {
    review = await ports.onPrepare(planned, target.machineId ?? undefined, fanoutAcknowledged)
  } catch (cause) {
    // Why: the hub refuses a card whose filing is incomplete. Its own sentence and the page
    // that fixes it are more use than a stack of words the person cannot act on.
    const setup =
      cause instanceof WorkflowRequestError && cause.detail.code === 'task_setup_required'
        ? cause.detail.taskSetup
        : null
    if (!setup) {
      throw cause
    }
    return {
      refusal: cause instanceof Error ? cause.message : String(cause),
      actionUrl: consoleActionUrl(setup.action_url)
    }
  }
  await ports.onDispatch(review)
  return { warnings: review.warnings ?? [] }
}
