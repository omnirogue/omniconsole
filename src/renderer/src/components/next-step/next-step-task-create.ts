import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { attachSessionToTask } from '@/components/tasks/create-task-submit'
import { readSessionPlaceChoice } from '@/store/session-place-store'
import { linkSessionToTask } from '@/store/session-task-store'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import {
  nextStepAgents,
  nextStepPeople,
  type NextStepDraft
} from '../../../../shared/next-step-draft'
import { resolveNextStepCardFiling } from './next-step-card-filing'
import type { NextStepSubject } from './next-step-subject'
import { cardlessHandoffsEnabledByPreference } from '../../../../shared/cardless-handoff-preference'

const CARD_TITLE_MAX = 160

type NextStepSession = Extract<NextStepSubject, { kind: 'session' }>['session']

/** The hub employee id behind the signed-in person, or null when it cannot be read. */
export async function signedInEmployeeId(): Promise<string | null> {
  try {
    const me = await window.api.consoleCompanies?.me()
    const id = me?.ok ? me.data.user?.employee_id : null
    return typeof id === 'string' && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}

/** The card a person receives is titled by the note's first line, else by the session. */
export function nextStepCardTitle(
  draft: Pick<NextStepDraft, 'note'>,
  sessionLabel: string
): string {
  const firstLine = draft.note
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return (firstLine ?? sessionLabel).slice(0, CARD_TITLE_MAX)
}

/** Unbound handoffs stand on their own unless this profile opted into task creation. */
export function cardlessHandoffsEnabled(): boolean {
  return cardlessHandoffsEnabledByPreference(useAppStore.getState().settings)
}

function wantsPerson(draft: NextStepDraft): boolean {
  return (
    nextStepPeople(draft).length > 0 ||
    (nextStepAgents(draft).length > 0 && draft.after.some((step) => step.kind === 'person'))
  )
}

/**
 * How hard the filing is: the fleet REQUIRES it, because the hub refuses to dispatch a
 * card without a company, department and goal. A handoff to a person must always reach
 * them, so it files the card when the place is known and creates it anyway when it is not
 * — an unfiled card still lands in that person's bucket, and no handoff is ever lost.
 */
export type NextStepCardFilingRule = 'required' | 'best-effort'

/**
 * The one card creator behind every next step: it files the card under the company,
 * department and goal the conversation belongs to, mints it, binds it to THIS
 * conversation and attaches the workspace. Callers differ in when they call it, and in
 * whether an unfilable card is a refusal or simply an unfiled one.
 */
export async function createNextStepCard(
  session: NextStepSession,
  title: string,
  note = '',
  rule: NextStepCardFilingRule = 'required'
): Promise<
  { task: { id: string; title: string } } | { refusal: string; actionUrl?: string | null }
> {
  // Why: a place chosen in Next actions overrides the folder's; the card lands where the person said.
  const filed = await resolveNextStepCardFiling(
    session.worktreeId,
    undefined,
    readSessionPlaceChoice(sidebarSessionSourceIdentity(session)?.sourceKey ?? null)
  )
  if ('refusal' in filed && rule === 'required') {
    return { refusal: filed.refusal.reason, actionUrl: filed.refusal.actionUrl }
  }
  const place = 'filing' in filed ? filed.filing : null
  const ownerEmployeeId = await signedInEmployeeId()
  const created = await window.api.backoffice.createTask({
    title: title.slice(0, CARD_TITLE_MAX),
    ...(place ? { companyId: place.companyId, unitId: place.unitId, goalId: place.goalId } : {}),
    ...(ownerEmployeeId ? { ownerEmployeeId } : {}),
    description: [
      note.trim(),
      translate('nextStep.cardFromSession', 'Created from the OmniConsole session “{{session}}”.', {
        session: session.label
      })
    ]
      .filter((part) => part.length > 0)
      .join('\n\n')
  })
  if (!created.ok) {
    return { refusal: created.message }
  }
  // Why: the card binds to THIS conversation, not to its folder. A workspace-wide
  // binding made every session in a folder share one card and stopped a task from
  // spanning folders, machines or people — the hub's session row is the real link.
  linkSessionToTask(sidebarSessionSourceIdentity(session)?.sourceKey ?? '', {
    taskId: created.taskId,
    title: created.title,
    at: new Date().toISOString()
  })
  void attachSessionToTask(session, created.taskId, {
    cwd: useAppStore.getState().getKnownWorktreeById(session.worktreeId)?.path ?? null,
    provider: session.agent
  })
  return { task: { id: created.taskId, title: created.title } }
}

/**
 * Existing task bindings travel with the handoff. Profiles that opted out of cardless
 * handoffs create a task only when this conversation does not already have one — and it
 * is created whether or not the estate's filing can be worked out, because handing work
 * to a person must always work.
 */
export async function ensureTaskForPeople(
  session: NextStepSession,
  draft: NextStepDraft
): Promise<{ draft: NextStepDraft } | { refusal: string }> {
  if (!wantsPerson(draft) || draft.handoff.task) {
    return { draft }
  }
  // Why: with card-less handoffs on, the request stands on its own; nothing is minted for it.
  if (cardlessHandoffsEnabled()) {
    return { draft }
  }
  const created = await createNextStepCard(
    session,
    nextStepCardTitle(draft, session.label),
    draft.note,
    'best-effort'
  )
  if ('refusal' in created) {
    return { refusal: created.refusal }
  }
  return {
    draft: { ...draft, handoff: { ...draft.handoff, task: created.task } }
  }
}
