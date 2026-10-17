import { keepFinishedSessionForMe, saveFinishedSession } from '@/lib/session-finish-actions'
import type { SessionFinishAction } from '@/lib/session-folders'
import { invalidateBackofficeWork } from '@/components/task-page/backoffice/backoffice-work-store'
import { translate } from '@/i18n/i18n'
import { finishThread } from './next-step-finish-thread'
import { doneRefusal, revisionOf, type NextStepActionResult } from './next-step-action-result'

export { doneRefusal, type NextStepActionResult } from './next-step-action-result'
import { getOutcomeProgress, listSessionOutcomesForOwner } from './next-step-outcome-client'
import { getAllSessionChainEntries } from '@/lib/session-chain-registry'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { SESSION_OUTCOME_RELAY_REFUSAL } from '../../../../shared/session-outcome-routing'
import { closeSessionTab } from '@/lib/close-session-tab'
import { waitLaterKeyForCard, waitLaterKeyForPane, waitLaterKeyForThread } from '@/lib/wait-later'
import { useAppStore } from '@/store'
import { useWaitLater } from '@/store/wait-later-store'
import { snoozeSessionsByPerson } from '@/lib/session-organization-person-changes'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import { isThreadRecipient, type NextStepSubject } from './next-step-subject'

const SESSION_SNOOZE_PREFIX = 'conversation:'

/** Why ⏳ is not offered here, or null when it is. */
export function waitRefusal(subject: NextStepSubject): string | null {
  switch (subject.kind) {
    case 'session':
      return subject.session.paneKey
        ? null
        : translate('nextStep.waitNoPane', 'Open this session in its workspace first.')
    case 'card':
      return null
    case 'thread':
      return isThreadRecipient(subject)
        ? null
        : translate('nextStep.threadNotMine', 'Only the person this was sent to can act on it.')
  }
}

/** The per-device key ⏳ files a subject under, or null when it cannot wait here. */
export function waitLaterKeyForSubject(subject: NextStepSubject): string | null {
  switch (subject.kind) {
    case 'session':
      return subject.session.paneKey ? waitLaterKeyForPane(subject.session.paneKey) : null
    case 'card':
      return waitLaterKeyForCard(subject.item.task_id)
    case 'thread':
      return waitLaterKeyForThread(subject.detail.thread.id)
  }
}

/** Bring a waiting subject back to the active view now; nothing else changes. */
export async function bringBackNextStep(subject: NextStepSubject): Promise<NextStepActionResult> {
  const key = waitLaterKeyForSubject(subject)
  if (!key) {
    return { ok: false, message: waitRefusal(subject) ?? '' }
  }
  return bringBackKey(key)
}

export function bringBackKey(key: string): NextStepActionResult {
  // Why: a session row's snooze is an organization change; other waits (panes, cards) are not.
  if (key.startsWith(SESSION_SNOOZE_PREFIX)) {
    snoozeSessionsByPerson([key.slice(SESSION_SNOOZE_PREFIX.length)], null, { via: 'work' })
  } else {
    useWaitLater.getState().setUntil(key, null)
  }
  return { ok: true, message: translate('nextStep.broughtBack', 'Back in your active view.') }
}

/**
 * ✓ on a session: its work is finished. The card it is bound to (when Tasks knows it) is
 * completed on the hub, and the session leaves Needs You on this device; the terminal
 * stays open, and a later ask from its agent is new attention.
 */
async function finishSession(
  session: Extract<NextStepSubject, { kind: 'session' }>['session'],
  linkedCard: BackofficeTodoItem | null,
  resultRef?: string,
  sessionFinish?: SessionFinishAction
): Promise<NextStepActionResult> {
  if (!session.paneKey || !session.tabId) {
    return {
      ok: false,
      message: translate('nextStep.waitNoPane', 'Open this session in its workspace first.')
    }
  }
  // Query the host even before renderer hydration: a stale or empty local registry cannot bypass saved obligations.
  try {
    const chains = await listSessionOutcomesForOwner(session)
    const bound = chains.filter(
      (chain) =>
        chain.outcomeSet &&
        (chain.sourceRowKey === session.rowKey ||
          chain.sourcePaneKey === session.paneKey ||
          chain.steps.some(
            (step) => step.kind !== 'handoff' && step.launchedPaneKey === session.paneKey
          ))
    )
    for (const chain of bound) {
      const progress = await getOutcomeProgress(chain.id, chain)
      if (progress.lifecycle !== 'complete') {
        return {
          ok: false,
          message:
            progress.reasons.join(' ') ||
            `${progress.satisfied} of ${progress.total} outcomes complete. Open the saved outcome to see what remains.`
        }
      }
    }
  } catch (error) {
    const legacyRelay =
      parseExecutionHostId(session.hostId)?.kind === 'ssh' &&
      error instanceof Error &&
      error.message === SESSION_OUTCOME_RELAY_REFUSAL
    const knownOutcome = getAllSessionChainEntries().some(
      ({ chain }) =>
        chain.outcomeSet &&
        (chain.sourceRowKey === session.rowKey ||
          chain.sourcePaneKey === session.paneKey ||
          chain.steps.some(
            (step) => step.kind !== 'handoff' && step.launchedPaneKey === session.paneKey
          ))
    )
    if (!legacyRelay || knownOutcome) {
      return {
        ok: false,
        message: translate(
          'nextStep.outcomeVerificationFailed',
          'The execution host could not verify saved outcomes. Reconnect and try again.'
        )
      }
    }
  }
  // Why: Done is normal completion, never a kill; closing the tab ends every pane in it, so a
  // working agent anywhere in the tab is left to finish or be stopped first.
  const state = useAppStore.getState()
  const tabPrefix = `${session.tabId}:`
  const working = Object.entries(state.agentStatusByPaneKey).some(
    ([paneKey, status]) => paneKey.startsWith(tabPrefix) && status?.state === 'working'
  )
  if (working) {
    return {
      ok: false,
      message: translate(
        'nextStep.stillWorking',
        'It is still working. Let it finish, or stop it first, then press Done.'
      )
    }
  }
  // Why: a workspace can name a card Tasks has not read yet; that card is then not completed here,
  // and the message says so instead of claiming it.
  const boundTaskId = state.getKnownWorktreeById(session.worktreeId)?.linkedWorkItem?.hubTaskId
  const revision = linkedCard ? revisionOf(linkedCard) : null
  let cardLine: string | null = null
  if (linkedCard && revision !== null && linkedCard.status?.toLowerCase() !== 'done') {
    const result = await window.api.backoffice.completeTask({
      taskId: linkedCard.task_id,
      expectedRevision: revision,
      ...(resultRef?.trim() ? { resultRef: resultRef.trim() } : {})
    })
    if (!result.ok) {
      if (result.stale) {
        invalidateBackofficeWork()
      }
      return {
        ok: false,
        message: result.message,
        ...(result.needsEvidence ? { evidenceItem: linkedCard } : {})
      }
    }
    invalidateBackofficeWork()
    cardLine = translate('nextStep.cardCompleted', '{{title}} is complete.', {
      title: linkedCard.title
    })
  } else if ((linkedCard && revision === null) || (!linkedCard && boundTaskId)) {
    cardLine = translate(
      'nextStep.cardNotCompleted',
      'Its task could not be completed from here; finish it in Tasks.'
    )
  }
  if (sessionFinish?.action === 'me') {
    if (!keepFinishedSessionForMe(session, sessionFinish)) {
      return {
        ok: false,
        message: translate(
          'nextStep.finishChoiceSaveFailed',
          'Could not save the finish choice. The session stayed open.'
        )
      }
    }
    useWaitLater.getState().setFinished(waitLaterKeyForPane(session.paneKey), new Date())
    const message = translate(
      'nextStep.sessionLeftInDone',
      'Done. The session is here for you in Done.'
    )
    return { ok: true, message: cardLine ? `${message} ${cardLine}` : message }
  }
  if (sessionFinish?.action === 'save') {
    if (!saveFinishedSession(session, sessionFinish.folderId)) {
      return {
        ok: false,
        message: translate(
          'nextStep.sessionSaveFailed',
          'Could not save this session. It has been kept open.'
        )
      }
    }
    useWaitLater.getState().setFinished(waitLaterKeyForPane(session.paneKey), new Date())
    const message = translate('nextStep.sessionSaved', 'Saved in Saved Sessions.')
    return { ok: true, message: cardLine ? `${message} ${cardLine}` : message }
  }
  useWaitLater.getState().setFinished(waitLaterKeyForPane(session.paneKey), new Date())
  // Pinned tabs and chats can refuse; report the result after the existing close path settles.
  const closed = await closeSessionTab(session.tabId)
  const sessionLine =
    closed === true
      ? translate(
          'nextStep.sessionDone',
          'Done. The session is closed; reopen it from Recently closed.'
        )
      : closed === false
        ? translate(
            'nextStep.sessionKeptOpen',
            'Done. The session stayed open; close it when ready.'
          )
        : translate(
            'nextStep.sessionClosing',
            'Done. The session is closing; its transcript stays.'
          )
  return { ok: true, message: cardLine ? `${sessionLine} ${cardLine}` : sessionLine }
}

/** ✓ Done: the card is completed on the hub; a thread gets the hub's own `done` entry. */
export async function finishNextStep(
  subject: NextStepSubject,
  linkedCard: BackofficeTodoItem | null,
  resultRef?: string,
  sessionFinish?: SessionFinishAction
): Promise<NextStepActionResult> {
  if (subject.kind === 'session') {
    return finishSession(subject.session, linkedCard, resultRef, sessionFinish)
  }
  const card = subject.kind === 'card' ? subject.item : null
  if (subject.kind === 'thread') {
    return finishThread(subject)
  }
  const revision = card ? revisionOf(card) : null
  if (!card || revision === null) {
    return { ok: false, message: doneRefusal(subject, linkedCard) ?? '' }
  }
  const result = await window.api.backoffice.completeTask({
    taskId: card.task_id,
    expectedRevision: revision,
    ...(resultRef?.trim() ? { resultRef: resultRef.trim() } : {})
  })
  if (result.ok) {
    invalidateBackofficeWork()
    return {
      ok: true,
      message: translate('nextStep.cardDone', '{{title}} is finished.', { title: card.title })
    }
  }
  if (result.stale) {
    // Why: the card moved on under this view; re-read it so the next click carries its revision.
    invalidateBackofficeWork()
  }
  return {
    ok: false,
    message: result.message,
    ...(result.needsEvidence ? { evidenceItem: card } : {})
  }
}
