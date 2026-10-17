import { reportSessionDisposition } from '@/components/next-step/next-step-outcome-client'
import { translate } from '@/i18n/i18n'
import { useSessionFolders } from '@/store/session-folders'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  dueSessionRunDisposition,
  type SessionRunDisposition
} from '../../../shared/session-run-completion'
import {
  closeSessionTab,
  sessionTabHasUnfinishedAgent,
  sessionTabIsOpen
} from './close-session-tab'
import { conversationViewKey } from './conversation-view'
import { sessionOwnsOutcomeChain } from './session-finish-host-choice'
import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import { outcomeOwnerKey } from './session-outcome-owner'
import type { SidebarSession } from './sidebar-sessions'

const running = new Set<string>()
/** Operations this window already reported as done; the host needs to hear it only once. */
const reported = new Set<string>()
/** A failed operation is not tried again before the host's next due time. */
const notBefore = new Map<string, number>()

type Performed = { ok: true } | { ok: false; error: string }
/** Files the row in its Saved folder; true once the device has recorded it. */
export type SaveFinishedSession = (
  session: SidebarSession,
  folderId: string | null
) => boolean | Promise<boolean>

/**
 * Carry out what the HOST recorded for a finished run (`outcomeSet.disposition`) and report the
 * result under its `operationId`. Close and save are window facts, so they happen here; whether
 * they are due, how often they are retried and whether they count as done is the host's record.
 * `completed` asks nothing of any window and never closes one. A `null` session is a source row
 * this device no longer has.
 */
export async function applyHostSessionDisposition(
  session: SidebarSession | null,
  chain: SessionChain,
  now: number,
  save: SaveFinishedSession
): Promise<void> {
  const due = chain.outcomeSet ? dueSessionRunDisposition(chain.outcomeSet, now) : null
  if (!due || due.intent === 'completed') {
    return
  }
  const operation = `${chain.id}:${due.operationId}`
  if (
    running.has(operation) ||
    reported.has(operation) ||
    (notBefore.get(operation) ?? 0) > now ||
    (session && (session.unavailable || !sessionOwnsOutcomeChain(session, chain))) ||
    // The source is still working or asking something: finishing it now would cut it off.
    (session?.tabId && sessionTabHasUnfinishedAgent(session.tabId))
  ) {
    return
  }
  running.add(operation)
  try {
    const performed = await performSessionDisposition(session, chain, due, save)
    if (!performed) {
      return
    }
    const recorded = await reportSessionDisposition({
      chain,
      operationId: due.operationId,
      ...performed
    })
    if (performed.ok) {
      reported.add(operation)
      mirrorAppliedDisposition(session, chain, due, now)
      return
    }
    const next = recorded.outcomeSet?.disposition?.nextAttemptAt
    if (next !== undefined) {
      notBefore.set(operation, next)
    }
  } catch (error) {
    // An unreachable host keeps the disposition pending; the next observation reports again.
    console.warn('[session-finish] disposition could not be reported', error)
  } finally {
    running.delete(operation)
  }
}

async function performSessionDisposition(
  session: SidebarSession | null,
  chain: SessionChain,
  due: SessionRunDisposition,
  save: SaveFinishedSession
): Promise<Performed | null> {
  if (due.intent === 'save') {
    if (!session) {
      // Saving files the row itself; without the row there is nothing to file yet.
      return null
    }
    return (await save(session, due.folderId ?? null))
      ? { ok: true }
      : {
          ok: false,
          error: translate(
            'upNext.dispositionError.saveFailed',
            'The session could not be saved on this device.'
          )
        }
  }
  const mirror = session
    ? useSessionFolders.getState().metadata.finishActions?.[conversationViewKey(session)]
    : undefined
  // A tab that is already gone is a close that already happened, whoever performed it.
  if (
    !session?.tabId ||
    !sessionTabIsOpen(session.tabId) ||
    (mirror?.chainId === chain.id && mirror.action === 'end' && mirror.applied)
  ) {
    return { ok: true }
  }
  const closed = await closeSessionTab(session.tabId, { rejectPinned: true })
  if (closed === true) {
    return { ok: true }
  }
  return {
    ok: false,
    // Why translated: the host stores this sentence and the person reads it back under Details.
    error:
      closed === false
        ? translate(
            'upNext.dispositionError.closeRefused',
            'The session is pinned or declined to close.'
          )
        : translate(
            'upNext.dispositionError.closeTimedOut',
            'Closing the session did not finish in time.'
          )
  }
}

/** The legacy device mirror follows the host record, so older readers of it agree with the host. */
function mirrorAppliedDisposition(
  session: SidebarSession | null,
  chain: SessionChain,
  due: SessionRunDisposition,
  now: number
): void {
  if (!session) {
    return
  }
  let executionOwnerKey: string | undefined
  try {
    executionOwnerKey = outcomeOwnerKey(chain)
  } catch {
    executionOwnerKey = undefined
  }
  useSessionFolders.getState().setFinishAction(conversationViewKey(session), {
    action: due.intent === 'save' ? 'save' : 'end',
    folderId: due.folderId ?? SAVED_SESSIONS_FOLDER_ID,
    chainId: chain.id,
    ...(executionOwnerKey ? { executionOwnerKey } : {}),
    revision: chain.outcomeSet!.revision,
    applied: true,
    completedAt: now
  })
}
