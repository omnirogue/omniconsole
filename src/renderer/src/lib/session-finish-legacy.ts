import { getOutcomeProgress } from '@/components/next-step/next-step-outcome-client'
import { useSessionFolders } from '@/store/session-folders'
import { closeSessionTab, sessionTabHasUnfinishedAgent } from './close-session-tab'
import { conversationViewKey } from './conversation-view'
import { getSessionChain } from './session-chain-registry'
import { sessionFinishOwnerMatches } from './session-finish-host-choice'
import type { SessionFinishAction } from './session-folders'
import type { SidebarSession } from './sidebar-sessions'

const running = new Set<string>()

/**
 * A host that predates the completion seal records only the INTENT (`sessionFinish`), so this
 * device still carries it out from its mirror. The host's word is required all the same: the
 * chain must still say the same finish, and a chain that carries a seal is never handled here —
 * its disposition record is (`session-finish-actions.ts`).
 */
export async function applyLegacySessionFinishAction(
  session: SidebarSession,
  expected: SessionFinishAction,
  perform: {
    keep(session: SidebarSession, choice: SessionFinishAction): boolean | Promise<boolean>
    save(session: SidebarSession, folderId: string | null): boolean | Promise<boolean>
  }
): Promise<void> {
  const key = conversationViewKey(session)
  if (
    running.has(key) ||
    expected.applied ||
    !expected.chainId ||
    !session.tabId ||
    session.unavailable
  ) {
    return
  }
  const chain = getSessionChain(expected.chainId, session)
  if (
    !chain?.outcomeSet ||
    chain.outcomeSet.completion ||
    // No finish on the host, or another one, means nothing here may close or save anything.
    chain.outcomeSet.sessionFinish?.action !== expected.action ||
    chain.sourceRowKey !== session.rowKey ||
    !sessionFinishOwnerMatches(chain, expected) ||
    chain.outcomeSet.revision !== expected.revision ||
    sessionTabHasUnfinishedAgent(session.tabId)
  ) {
    return
  }
  running.add(key)
  try {
    const progress = await getOutcomeProgress(chain.id, chain, { verifySourceReady: true })
    const current = useSessionFolders.getState().metadata.finishActions?.[key]
    if (
      current !== expected ||
      progress.lifecycle !== 'complete' ||
      progress.chain.outcomeSet?.completion ||
      progress.chain.id !== chain.id ||
      progress.chain.sourceRowKey !== session.rowKey ||
      !sessionFinishOwnerMatches(progress.chain, expected) ||
      progress.chain.outcomeSet?.revision !== expected.revision ||
      sessionTabHasUnfinishedAgent(session.tabId)
    ) {
      return
    }
    if (expected.action === 'me') {
      await perform.keep(session, expected)
      return
    }
    const done =
      expected.action === 'save'
        ? await perform.save(session, expected.folderId)
        : (await closeSessionTab(session.tabId, { rejectPinned: true })) === true
    if (done) {
      useSessionFolders
        .getState()
        .setFinishAction(key, { ...expected, applied: true, completedAt: Date.now() })
    }
  } catch (error) {
    // Unavailable hosts leave the session and saved intent intact for the next observation.
    console.warn('[session-finish] completion could not be applied', error)
  } finally {
    running.delete(key)
  }
}
